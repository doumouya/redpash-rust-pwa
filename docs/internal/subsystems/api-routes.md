---
title: API routes
section: Internal
order: 21
last modified date: 2026-05-24
owner: Gus
status: stub
---

# API routes

> **TODO (Gus).** Fill from `backend/crates/api/src/routes/`.

To cover:

- Every `/api/*` route — purpose, method, auth posture, owning module
- The `router(state)` composition in `routes/mod.rs` — middleware order (request_id → capture → body limit → API → fallback to ServeDir)
- How a new resource is added (nest a `Router` under `/api/<name>`)
- Auth resolution: `resolve_user_rid` from headers → bootstrap dev-user fallback
- CORS + compression + tracing layers — what each catches
