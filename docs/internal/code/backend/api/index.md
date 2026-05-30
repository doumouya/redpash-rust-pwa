---
title: Internal · Code · Backend · api — atomic docs for backend/crates/api/src/
section: Internal · Code · Backend · api
order: 1
last modified date: 2026-05-30
---

# api crate — atomic docs

Axum 0.7 HTTP server. One route module per resource under
[`routes/`](routes/); shared infrastructure (state, error, event capture,
request log, ids) at the crate root. Per-resource SQL helpers in
[`db/`](db/); maintenance binaries in [`bin/`](bin/).

**Coverage at baseline (2026-05-30):** 42 atomic units (9 root + 25 routes + 6 db + 2 bin), 0 documented.

## Root modules (`api/`)

| File | Atomic doc | Role |
|---|---|---|
| `main.rs` | [main.md](main.md) | boot, tracing init, Postgres pool, bind |
| `state.rs` | [state.md](state.md) | `AppState` — db pool, FileEntry cache, OAuthConfig, http client |
| `bootstrap.rs` | [bootstrap.md](bootstrap.md) | idempotent dev_user + default project on first run |
| `id.rs` | [id.md](id.md) | RedPash-ID generator (`PFX_<32 uppercase hex>`) |
| `error.rs` | [error.md](error.md) | `AppError` + `IntoResponse` + `From<DataError>` |
| `event.rs` | [event.md](event.md) | runtime event capture — fire-and-forget `record()` |
| `request_log.rs` | [request_log.md](request_log.md) | per-HTTP-request row (method, route, status, duration, request_id) |
| `db_query.rs` | [db_query.md](db_query.md) | per-DB-query timing capture (2026-05-29) |
| `redact.rs` | [redact.md](redact.md) | secret-redaction helpers for events / logs |

## Subdirs

- [`routes/`](routes/) — 25 route modules (one per resource)
- [`db/`](db/) — 6 SQL-helper modules
- [`bin/`](bin/) — 2 maintenance binaries (audit_ingest, audit_distincts)

## Related

- [Backend pillar landing](../index.md)
- [Public REDMAP — api section](../../../../../REDMAP.md)
- [Subsystem: api-routes](../../../subsystems/api-routes.md)
