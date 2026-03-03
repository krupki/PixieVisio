# Realtime Drawing Microservice (Go)

A lightweight WebSocket service that ingests high-frequency drawing deltas, batches them in memory per document, and flushes them to a backend endpoint. This keeps the main backend and database from being flooded with tiny writes.

## Endpoints
- `GET /healthz` — liveness probe.
- `GET /ws?docId=<id>&userId=<id>` — WebSocket endpoint. Each message is treated as a drawing delta payload. Messages are not parsed; they are wrapped with metadata and batched.

## Configuration (env vars)
- `ADDR` — listen address (default `:8081`).
- `BACKEND_URL` — optional HTTP endpoint to receive flushed batches (POST). If empty, batches are dropped after logging.
- `FLUSH_INTERVAL_MS` — flush cadence in ms (default `75`).
- `MAX_BATCH` — flush after this many messages per document (default `64`).

## Run locally
```bash
# from repo root
cd realtime-service
go run ./...
```

## Message lifecycle
1) Client opens `/ws?docId=123&userId=abc` and starts sending messages (any JSON payload).
2) Service wraps each payload with `docId`, `userId`, and `receivedAt`, then enqueues it to the per-document worker.
3) Worker flushes either when `MAX_BATCH` is reached or `FLUSH_INTERVAL_MS` elapses, posting a JSON body `{ "docId": "123", "events": [...] }` to `BACKEND_URL`.

## Hardening hooks
- Restrict `CheckOrigin` in `main.go` to your allowed domains.
- Add auth (e.g., bearer token or signed query parameter) before upgrading the socket.
- Adjust `ReadLimit`/timeouts in the WebSocket handler as needed.
