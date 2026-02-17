# PixieVisio

PixieVisio is a collaborative diagram/canvas prototype with a split architecture:

- React + PixiJS frontend for interactive node/connection editing
- ASP.NET Core API + SQLite for persistence
- Go realtime microservice (WebSocket ingest + batch flush)

## Architecture

- `client/` — Vite + React + PixiJS canvas app
- `server/` — .NET 8 minimal API, EF Core, SQLite storage
- `realtime-service/` — Go WebSocket service with in-memory batching and metrics endpoint

## Local development

### 1) Backend API (.NET)

From `server/`:

```bash
dotnet restore
dotnet build
dotnet run
```

Default URL: `http://localhost:5000`

### 2) Realtime service (Go)

From `realtime-service/`:

```bash
go run ./...
```

Default URL: `http://localhost:8081`

### 3) Frontend (Vite)

From `client/`:

```bash
npm install
npm run dev
```

## Frontend environment

Copy `client/.env.example` to `client/.env` and adjust if needed:

- `VITE_BACKEND_BASE_URL` (default: `http://localhost:5000`)
- `VITE_REALTIME_BASE_URL` (default: `http://localhost:8081`)

## Service endpoints

- Backend: `GET /api/health`, `POST /api/save`, `GET /api/load`
- Realtime service: `GET /healthz`, `GET /metrics`, `GET /ws?docId=<id>&userId=<id>`

## What this project demonstrates

- Multi-service design with clear separation of concerns
- Realtime event ingestion with batched flush strategy to reduce backend write pressure
- Persisted graph model (nodes + edges) with reload flow
- Basic service health + metrics visibility from the UI
