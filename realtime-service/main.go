package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// ChangeEvent is a thin envelope around a drawing delta.
type ChangeEvent struct {
	DocID      string          `json:"docId"`
	UserID     string          `json:"userId,omitempty"`
	Sequence   uint64          `json:"seq,omitempty"`
	ReceivedAt time.Time       `json:"receivedAt"`
	Payload    json.RawMessage `json:"payload"`
}

// Flusher persists a batch of deltas for a document.
type Flusher interface {
	Flush(ctx context.Context, docID string, batch []ChangeEvent) error
}

// HTTPFlusher posts batched changes to a backing HTTP endpoint.
type HTTPFlusher struct {
	client     *http.Client
	backendURL string
}

func NewHTTPFlusher(backendURL string) *HTTPFlusher {
	return &HTTPFlusher{
		client:     &http.Client{Timeout: 10 * time.Second},
		backendURL: backendURL,
	}
}

func (f *HTTPFlusher) Flush(ctx context.Context, docID string, batch []ChangeEvent) error {
	if f.backendURL == "" {
		// No configured sink; drop silently but keep the pipeline hot.
		log.Printf("flush skipped: backend URL not configured; doc=%s batch=%d", docID, len(batch))
		return nil
	}

	body, err := json.Marshal(struct {
		DocID  string        `json:"docId"`
		Events []ChangeEvent `json:"events"`
	}{DocID: docID, Events: batch})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.backendURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := f.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		return errors.New("unexpected status " + resp.Status)
	}
	return nil
}

type docWorker struct {
	docID         string
	flusher       Flusher
	flushInterval time.Duration
	maxBatch      int
	input         chan ChangeEvent
	flushNow      chan struct{}
	quit          chan struct{}
	wg            *sync.WaitGroup
	metrics       *metrics
}

func newDocWorker(docID string, flusher Flusher, flushInterval time.Duration, maxBatch int, wg *sync.WaitGroup, m *metrics) *docWorker {
	w := &docWorker{
		docID:         docID,
		flusher:       flusher,
		flushInterval: flushInterval,
		maxBatch:      maxBatch,
		input:         make(chan ChangeEvent, 1024),
		flushNow:      make(chan struct{}, 1),
		quit:          make(chan struct{}),
		wg:            wg,
		metrics:       m,
	}
	wg.Add(1)
	go w.run()
	return w
}

func (w *docWorker) run() {
	defer w.wg.Done()
	ticker := time.NewTicker(w.flushInterval)
	defer ticker.Stop()

	buffer := make([]ChangeEvent, 0, w.maxBatch*2)

	flush := func() {
		if len(buffer) == 0 {
			return
		}
		batch := make([]ChangeEvent, len(buffer))
		copy(batch, buffer)
		buffer = buffer[:0]
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := w.flusher.Flush(ctx, w.docID, batch); err != nil {
			log.Printf("flush error doc=%s err=%v", w.docID, err)
			w.metrics.recordError(err)
		}
		w.metrics.recordFlush(w.docID, len(batch))
	}

	for {
		select {
		case evt := <-w.input:
			buffer = append(buffer, evt)
			w.metrics.recordEvent()
			if len(buffer) >= w.maxBatch {
				flush()
			}
		case <-w.flushNow:
			flush()
		case <-ticker.C:
			flush()
		case <-w.quit:
			flush()
			return
		}
	}
}

func (w *docWorker) enqueue(evt ChangeEvent) {
	select {
	case w.input <- evt:
	default:
		// Channel is full; signal the worker to flush immediately to make room.
		log.Printf("backpressure doc=%s; signaling early flush", w.docID)
		select {
		case w.flushNow <- struct{}{}:
		default:
			// Flush already signalled; a flush is already in flight.
		}
		select {
		case w.input <- evt:
		case <-time.After(5 * time.Millisecond):
			log.Printf("drop event doc=%s due to sustained backpressure", w.docID)
		}
	}
}

func (w *docWorker) stop() {
	close(w.quit)
}

type hub struct {
	mu            sync.Mutex
	workers       map[string]*docWorker
	flusher       Flusher
	flushInterval time.Duration
	maxBatch      int
	wg            sync.WaitGroup
	metrics       *metrics
}

func newHub(flusher Flusher, flushInterval time.Duration, maxBatch int, m *metrics) *hub {
	return &hub{
		workers:       make(map[string]*docWorker),
		flusher:       flusher,
		flushInterval: flushInterval,
		maxBatch:      maxBatch,
		metrics:       m,
	}
}

func (h *hub) enqueue(evt ChangeEvent) {
	h.mu.Lock()
	worker, ok := h.workers[evt.DocID]
	if !ok {
		worker = newDocWorker(evt.DocID, h.flusher, h.flushInterval, h.maxBatch, &h.wg, h.metrics)
		h.workers[evt.DocID] = worker
	}
	h.mu.Unlock()
	worker.enqueue(evt)
}

func (h *hub) shutdown(ctx context.Context) {
	h.mu.Lock()
	for _, w := range h.workers {
		w.stop()
	}
	h.mu.Unlock()
	done := make(chan struct{})
	go func() {
		h.wg.Wait()
		close(done)
	}()
	select {
	case <-ctx.Done():
	case <-done:
	}
}

// Config holds runtime knobs.
type Config struct {
	Addr           string
	BackendURL     string
	FlushInterval  time.Duration
	MaxBatch       int
	AllowedOrigins map[string]struct{}
}

func loadConfig() Config {
	cfg := Config{
		Addr:           ":8081",
		BackendURL:     "http://localhost:5000/api/save",
		FlushInterval:  75 * time.Millisecond,
		MaxBatch:       64,
		AllowedOrigins: parseAllowedOrigins("http://localhost:5173,http://127.0.0.1:5173"),
	}

	if v := os.Getenv("ADDR"); v != "" {
		cfg.Addr = v
	}
	if v := os.Getenv("FLUSH_INTERVAL_MS"); v != "" {
		if ms, err := strconv.Atoi(v); err == nil && ms > 0 {
			cfg.FlushInterval = time.Duration(ms) * time.Millisecond
		}
	}
	if v := os.Getenv("MAX_BATCH"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.MaxBatch = n
		}
	}
	if v := os.Getenv("ALLOWED_ORIGINS"); v != "" {
		parsed := parseAllowedOrigins(v)
		if len(parsed) == 0 {
			log.Printf("ALLOWED_ORIGINS is set but no valid origins were parsed; rejecting all browser origins")
		}
		cfg.AllowedOrigins = parsed
	}
	return cfg
}

func parseAllowedOrigins(raw string) map[string]struct{} {
	allowed := make(map[string]struct{})
	for _, candidate := range strings.Split(raw, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		normalized, ok := normalizeOrigin(candidate)
		if !ok {
			log.Printf("ignoring invalid allowed origin %q", candidate)
			continue
		}
		allowed[normalized] = struct{}{}
	}
	return allowed
}

func normalizeOrigin(origin string) (string, bool) {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", false
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", false
	}
	return scheme + "://" + strings.ToLower(parsed.Host), true
}

func isOriginAllowed(origin string, allowed map[string]struct{}) bool {
	if len(allowed) == 0 {
		return false
	}
	normalized, ok := normalizeOrigin(origin)
	if !ok {
		return false
	}
	_, exists := allowed[normalized]
	return exists
}

type metrics struct {
	mu             sync.Mutex
	totalEvents    uint64
	totalBatches   uint64
	lastFlushDoc   string
	lastFlushAt    time.Time
	lastFlushBatch int
	lastError      string
}

func newMetrics() *metrics {
	return &metrics{}
}

func (m *metrics) recordEvent() {
	m.mu.Lock()
	m.totalEvents++
	m.mu.Unlock()
}

func (m *metrics) recordFlush(docID string, batchSize int) {
	m.mu.Lock()
	m.totalBatches++
	m.lastFlushDoc = docID
	m.lastFlushBatch = batchSize
	m.lastFlushAt = time.Now().UTC()
	m.mu.Unlock()
}

func (m *metrics) recordError(err error) {
	m.mu.Lock()
	m.lastError = err.Error()
	m.mu.Unlock()
}

type metricsResponse struct {
	TotalEvents    uint64          `json:"totalEvents"`
	TotalBatches   uint64          `json:"totalBatches"`
	LastFlushDoc   string          `json:"lastFlushDoc"`
	LastFlushBatch int             `json:"lastFlushBatch"`
	LastFlushAt    time.Time       `json:"lastFlushAt"`
	LastError      string          `json:"lastError,omitempty"`
	PerDocQueues   []perDocMetrics `json:"perDocQueues"`
}

type perDocMetrics struct {
	DocID      string `json:"docId"`
	QueueDepth int    `json:"queueDepth"`
}

func websocketHandler(h *hub, allowedOrigins map[string]struct{}) http.HandlerFunc {
	upgrader := websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 1024,
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			if isOriginAllowed(origin, allowedOrigins) {
				return true
			}
			log.Printf("rejected websocket origin=%q remote=%s", origin, r.RemoteAddr)
			return false
		},
	}

	return func(w http.ResponseWriter, r *http.Request) {
		docID := r.URL.Query().Get("docId")
		if docID == "" {
			http.Error(w, "missing docId", http.StatusBadRequest)
			return
		}
		userID := r.URL.Query().Get("userId")

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("upgrade failed: %v", err)
			return
		}
		defer conn.Close()

		conn.SetReadLimit(1 << 20) // 1 MB per message
		conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		conn.SetPongHandler(func(string) error {
			conn.SetReadDeadline(time.Now().Add(30 * time.Second))
			return nil
		})

		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
					log.Printf("read error doc=%s err=%v", docID, err)
				}
				return
			}
			evt := ChangeEvent{
				DocID:      docID,
				UserID:     userID,
				ReceivedAt: time.Now().UTC(),
				Payload:    append([]byte(nil), msg...),
			}
			h.enqueue(evt)
		}
	}
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}

func metricsHandler(m *metrics, h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		resp := metricsResponse{}
		m.mu.Lock()
		resp.TotalEvents = m.totalEvents
		resp.TotalBatches = m.totalBatches
		resp.LastFlushDoc = m.lastFlushDoc
		resp.LastFlushBatch = m.lastFlushBatch
		resp.LastFlushAt = m.lastFlushAt
		resp.LastError = m.lastError
		m.mu.Unlock()

		h.mu.Lock()
		resp.PerDocQueues = make([]perDocMetrics, 0, len(h.workers))
		for id, wkr := range h.workers {
			resp.PerDocQueues = append(resp.PerDocQueues, perDocMetrics{
				DocID:      id,
				QueueDepth: len(wkr.input),
			})
		}
		h.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}
}

func main() {
	cfg := loadConfig()
	m := newMetrics()

	flusher := NewHTTPFlusher(cfg.BackendURL)
	hub := newHub(flusher, cfg.FlushInterval, cfg.MaxBatch, m)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", websocketHandler(hub, cfg.AllowedOrigins))
	mux.HandleFunc("/healthz", healthHandler)
	mux.HandleFunc("/metrics", metricsHandler(m, hub))

	srv := &http.Server{
		Addr:         cfg.Addr,
		Handler:      logRequests(withCORS(mux)),
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  30 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("server shutdown error: %v", err)
		}
		hub.shutdown(shutdownCtx)
	}()

	log.Printf("realtime service listening on %s", cfg.Addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server error: %v", err)
	}
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start))
	})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
