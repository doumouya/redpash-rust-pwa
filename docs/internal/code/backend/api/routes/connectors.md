---
title: backend/crates/api/src/routes/connectors.rs
source: ../../../../../../backend/crates/api/src/routes/connectors.rs
owner: Torv
section: Internal · Code · backend · api · routes
last modified date: 2026-06-04
---

# connectors.rs

## Purpose

`/api/connectors` — the persisted connector configs (Kafka today; S3 / DB-CDC
later). The framework half of connector-through-framework: instead of the
`load.sh` env hardcode, the user **creates a connection and picks which project
the data lands in**, and the loader reads that choice (Em 2026-06-04: "ask the
user which project he wants to add the file").

```
GET  /api/connectors        list the connectors the caller can reach
POST /api/connectors        create one — body picks the destination project
GET  /api/connectors/:rid   fetch one connector summary
```

## Public surface

- `pub fn routes() -> Router<AppState>` — the three routes above.
- `create` (POST `/`) — validates `name` + `project_id`, gates the caller to
  **≥Member write-reach** on the chosen project via `rbac::require_grant`
  (the same write-check `pipeline::upload_csv` applies at load), then
  `db::insert_connector` (as_user = created_by = the caller) + a
  `connector_create` event. Returns 201 + the `ConnectorSummary`.
- `list` (GET `/`) — `db::list_connectors(caller)` (reach-aware).
- `get_one` (GET `/:rid`) — `db::get_connector` then `rbac::require_view` on the
  destination project (leak-free: unreachable reads as not-found).

## Drift-prone areas

- **The create-time RBAC gate must equal the upload write-check.** `create` uses
  `require_grant(… r >= Role::Member)` — the same predicate the upload pipeline
  enforces — so a connection can only target a project the caller could upload
  to. If the upload write-reach definition changes, change this in lockstep, or a
  connection could point somewhere the load would then reject (or vice-versa).
- **Fail-closed, no leak.** `require_grant` / `require_view` 404 a project the
  caller can't reach (never "exists but not yours"). Don't add an explicit
  existence pre-check that would leak the distinction.
- **Nested under `/api`, NOT `/api/projects/:prj`.** Connectors are queried by id
  by the loader (`get_connector_load_cfg`) and listed reach-scoped, so they live
  at the top-level `/connectors` (registered in `routes/mod.rs`). If they later
  move under a project prefix, the loader's resolve-by-id path must still work.
- **The cluster creds are NOT in the body.** Only name/topic/project_id/kind. SASL
  creds stay in the connector's `.env` for the RC; if they move into the
  connection, add encryption-at-rest before accepting them here.

## Related

- [db/connectors.rs](db/connectors.md) — the CRUD + the reach-aware list.
- [routes/projects.rs](projects.md) — the create-handler + `require_grant` pattern this mirrors.
- [kafka_loader.rs](kafka_loader.md) — the loader resolves a `CON_` rid via `Cfg::from_connection`.
