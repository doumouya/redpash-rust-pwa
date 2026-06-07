---
title: backend/crates/api/src/routes/connectors.rs
source: ../../../../../../backend/crates/api/src/routes/connectors.rs
owner: Torv
section: Internal · Code · backend · api · routes
last modified date: 2026-06-07
---

# connectors.rs

## Purpose

`/api/connectors` — the persisted connector configs (Kafka today; S3 / DB-CDC
later). The framework half of connector-through-framework: instead of the
`load.sh` env hardcode, the user **creates a connection and picks which project
the data lands in**, and the loader reads that choice (Em 2026-06-04: "ask the
user which project he wants to add the file").

```
GET    /api/connectors            list the connectors the caller can reach
POST   /api/connectors            create one — body picks the destination project (+ config)
GET    /api/connectors/:rid       fetch one connector summary
PATCH  /api/connectors/:rid       rename (manage = Admin+ on its project)
DELETE /api/connectors/:rid       delete (Admin+; the row cascades via the registry)
POST   /api/connectors/:rid/sync  run the extract → CSV → a new project file (Pull); mysql/postgres/kafka; body {table?} (SQL) / {max_records?} (kafka, capped)
GET    /api/connectors/:rid/tables   list the source DB's tables (Tables facet; VIEW-gated)
GET    /api/connectors/:rid/schema   ?table= — a table's columns + types + projection (Schema facet; VIEW-gated)
POST   /api/connectors/:rid/test     probe the source connection — connect + SELECT 1 (Settings "Test connection"; VIEW-gated)
POST   /api/connectors/:rid/query    run an ad-hoc READ-ONLY SELECT (Admin DB Console; PLATFORM-ADMIN-gated, audited; postgres v1)
```

`run_query` (POST `/:rid/query`) — the Admin **DB Console**'s ad-hoc SELECT. Layered on the
connector's project VIEW + a **platform-admin** check (leak-free 404 on deny — the SQL console
is admin power); postgres-only in v1 → `postgres_loader::query` (read-only txn + statement_timeout
+ LIMIT + guard). Every statement is audited (`events` kind=`db_query`: connector, sql, rows). The
write side (SQL-console push) is a separate role-gated slice.

## Public surface

- `pub fn routes() -> Router<AppState>` — the routes above.
- `create` (POST `/`) — validates `name` + `project_id`, gates the caller to
  **≥Member write-reach** on the chosen project via `rbac::require_grant`
  (the same write-check `pipeline::upload_csv` applies at load), then
  `db::insert_connector` (as_user = created_by = the caller; + the connector-specific
  `config` JSONB) + a `connector_create` event. Returns 201 + the `ConnectorSummary`.
  **Secret-at-rest:** a plaintext `config.sasl_secret` (kafka) is encrypted via
  [`secrets::encrypt`](../secrets.md) into `sasl_secret_enc` + `creds_version` BEFORE
  `insert_connector` — the plaintext is never persisted; errors loudly (no master key)
  rather than storing cleartext. Generic over kinds (the standard for future connectors).
- `sync` (POST `/:rid/sync`) — runs the connector's extract → CSV → a new project
  file ("Pull"). Same ≥Member write-reach gate as create; **dispatches by `kind`**
  — `mysql` → `mysql_loader::run`, `postgres` → `postgres_loader::run` (in-process
  sqlx SELECT), `kafka` → `kafka_loader::run` (a BOUNDED rskafka consume; `run`
  returns `Option` → `None` (0 records) maps to a clean 400 "nothing loaded"). Other
  kinds → 400. Body knobs: `{table}` pulls a SPECIFIC SQL table (Tables-facet browse);
  `{max_records}` caps a kafka pull, **clamped server-side to `KAFKA_MAX_RECORDS_CAP`
  (5000)** so a synchronous request can't be asked for an unbounded batch. Returns
  `{ file }`. (Dispatch is additive; the open loader **registry** is the shared
  `connectors_core` co-design.)
- `tables` (GET `/:rid/tables`) — list the source DB's tables (`mysql`/`postgres`
  `list_tables`) for the **Tables** sub-tab. **VIEW**-gated. Returns `{ items }`
  (the `{name,rows,kind}` shape is serde-identical across loaders).
- `test_connection` (POST `/:rid/test`) — probe the source connection for the Settings
  **Test connection** action: `db::get_connector` → `require_view` → the loader's `probe`
  (connect + `SELECT 1`). A standalone handler (NOT folded into the sync/tables/schema
  match) so it composes additively. **VIEW**-gated; returns `{ ok: true }`. MySQL +
  postgres + kafka wired (each loader's `probe`; kafka = `list_topics` + topic-visible,
  no consume).
- `schema` (GET `/:rid/schema?table=`) — one table's columns + types + projection
  strategy (`mysql`/`postgres` `describe_table`) for the **Schema** sub-tab. VIEW-gated.
- `list` (GET `/`) — `db::list_connectors(caller)` (reach-aware).
- `get_one` (GET `/:rid`) — `db::get_connector` then `rbac::require_view` on the
  destination project (leak-free: unreachable reads as not-found).
- `rename` (PATCH `/:rid`) — managing a connector is **admin power**: gates on
  **≥Admin reach** to the destination project (a step above the ≥Member create gate),
  then `db::rename_connector` + a `connector_rename` event. `{ name }` body; empty
  name → 400; unreachable → leak-free 404. Returns the updated `ConnectorSummary`.
- `remove` (DELETE `/:rid`) — same ≥Admin gate, then `db::delete_connector` (the row
  cascades off the entity registry; previously-pulled CSV files are untouched) + a
  `connector_delete` event. Returns 204.

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
- **Connector-specific `config` JSONB now rides the create body** (e.g. the MySQL
  connection `{host,port,user,password,database,table}`). Kafka keeps its SASL
  creds in the RC `.env`; MySQL v1 stores its connection in `config` — plaintext,
  **localhost-only**; harden to `.env` / encrypt-at-rest before non-localhost.

## Related

- [db/connectors.rs](db/connectors.md) — the CRUD + the reach-aware list.
- [routes/projects.rs](projects.md) — the create-handler + `require_grant` pattern this mirrors.
- [kafka_loader.rs](kafka_loader.md) — the loader resolves a `CON_` rid via `Cfg::from_connection`.
