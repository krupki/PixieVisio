package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLoadConfigDefaults(t *testing.T) {
	t.Setenv("ADDR", "")
	t.Setenv("FLUSH_INTERVAL_MS", "")
	t.Setenv("MAX_BATCH", "")

	cfg := loadConfig()

	if cfg.Addr != ":8081" {
		t.Fatalf("expected default addr :8081, got %s", cfg.Addr)
	}
	if cfg.FlushInterval != 75*time.Millisecond {
		t.Fatalf("expected default flush interval 75ms, got %s", cfg.FlushInterval)
	}
	if cfg.MaxBatch != 64 {
		t.Fatalf("expected default max batch 64, got %d", cfg.MaxBatch)
	}
}

func TestLoadConfigFromEnv(t *testing.T) {
	t.Setenv("ADDR", ":9090")
	t.Setenv("FLUSH_INTERVAL_MS", "120")
	t.Setenv("MAX_BATCH", "128")

	cfg := loadConfig()

	if cfg.Addr != ":9090" {
		t.Fatalf("expected addr :9090, got %s", cfg.Addr)
	}
	if cfg.FlushInterval != 120*time.Millisecond {
		t.Fatalf("expected flush interval 120ms, got %s", cfg.FlushInterval)
	}
	if cfg.MaxBatch != 128 {
		t.Fatalf("expected max batch 128, got %d", cfg.MaxBatch)
	}
}

func TestWithCORSHandlesPreflight(t *testing.T) {
	called := false
	handler := withCORS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodOptions, "/healthz", nil)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if called {
		t.Fatalf("next handler should not be called for OPTIONS preflight")
	}
	if rr.Code != http.StatusNoContent {
		t.Fatalf("expected status 204, got %d", rr.Code)
	}
	if rr.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("expected wildcard CORS origin header")
	}
}

func TestParseAllowedOrigins(t *testing.T) {
	allowed := parseAllowedOrigins("http://localhost:5173, https://example.com ,invalid,ftp://bad")

	if len(allowed) != 2 {
		t.Fatalf("expected 2 valid origins, got %d", len(allowed))
	}
	if _, ok := allowed["http://localhost:5173"]; !ok {
		t.Fatalf("expected localhost origin to be parsed")
	}
	if _, ok := allowed["https://example.com"]; !ok {
		t.Fatalf("expected example.com origin to be parsed")
	}
}

func TestIsOriginAllowed(t *testing.T) {
	allowed := parseAllowedOrigins("http://localhost:5173")

	if !isOriginAllowed("http://localhost:5173", allowed) {
		t.Fatalf("expected configured origin to be allowed")
	}
	if isOriginAllowed("https://localhost:5173", allowed) {
		t.Fatalf("expected different scheme to be rejected")
	}
	if isOriginAllowed("http://evil.example", allowed) {
		t.Fatalf("expected unknown origin to be rejected")
	}
	if isOriginAllowed("", allowed) {
		t.Fatalf("expected empty origin to be rejected")
	}
}
