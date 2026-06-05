---
title: backend/crates/api/src/mysql_loader.rs
source: ../../../../../backend/crates/api/src/mysql_loader.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-06-05
---

# mysql_loader.rs

## Purpose

The **MySQL connector loader** — extract a table from an external MySQL via
Rust-native `sqlx` → CSV → `pipeline::upload_csv` (the framework write: RBAC +
parse + `insert_file` + audit). Thin transport like `kafka_loader`: it NEVER
calls `db::insert_*` directly (connector-through-framework; connectors-audit
enforces). Unlike Kafka's binary-mode consume, a sqlx `SELECT` is quick, so this
runs **in-process** from the SheetWise "Pull" sync endpoint
(`POST /api/connectors/:rid/sync` → `routes/files`… no, `routes/connectors::sync`).

The live source is read-only (one `SELECT`); the rows land as a CSV file the
customer queries — a safe, disposable copy, never the source DB (Em's zero-risk
model). Extraction is **type-aware**: each column is projected by its
`information_schema` `DATA_TYPE` — spatial → `ST_AsText` (WKT), binary/blob →
`HEX`, `bit` → unsigned-int text, everything else → `CAST … AS CHAR` — so
geometry/binary no longer land as corrupt bytes. The session is pinned on
connect (utf8mb4 · `time_zone='+00:00'` · a known `sql_mode`, all **SESSION**
scope) for faithful, reproducible output; rows **stream** (no full-table
buffering); and a decode error is **surfaced, never swallowed**.

## Public surface

- `pub struct Cfg` + `Cfg::from_connection(pool, CON_id)` — reads the `connectors`
  row (kind=`mysql`; destination project + as_user; `config` JSONB = the MySQL
  connection `{conn | host/port/user/password, database, table}`).
- `pub async fn run(pool, data_dir, &Cfg) -> Result<String>` — connect (pinned
  session) → list columns + `DATA_TYPE` (information_schema) → type-aware `SELECT`
  → stream rows → CSV → `pipeline::upload_csv` → returns the new file rid.
- `project_expr(col, data_type)` / `is_recognized(data_type)` — the single
  type→strategy map (extend here, never branch in `run`); an unrecognized type
  extracts via `CAST AS CHAR` and is `warn!`-logged.

## Drift-prone areas

- **No `db::insert_*`** — must route through `pipeline::upload_csv` (connectors-audit
  red otherwise). The `as_user`'s write-reach is re-checked there (caller_is_admin=false).
- localhost v1 connection: `ssl-mode=DISABLED` (sqlx has no TLS backend feature
  enabled) is allowed **only for loopback** hosts (127.0.0.1 / ::1 / localhost) —
  `from_connection` **rejects a remote host** (it would transport creds + data in
  plaintext). To support remote MySQL, enable a sqlx TLS feature
  (`runtime-tokio-rustls` + `tls-rustls`) + default to `ssl-mode=REQUIRED`.
- **Type-aware projection lives in `project_expr`** — the ONE place MySQL's type
  surface is mapped. Add a type there; never branch in `run`. `is_recognized`
  `warn!`s an unmapped type so a new MySQL type surfaces instead of silently
  mangling (`CAST AS CHAR` is the safe default).
- **Session pins are SESSION scope only** (utf8mb4 / `time_zone='+00:00'` /
  `sql_mode`) — never `GLOBAL`/`PERSIST`; the source's global state is never
  mutated. Pinning is what makes a pull reproducible across servers; only the
  *read-affecting* sql_mode bits matter (strict/write modes are irrelevant to a
  read-only SELECT).
- Decode errors are **surfaced** (`try_get(..)?`), not swallowed — every column
  is projected to a text/hex/WKT string, so a decode error is a real anomaly.
- **`information_schema` metadata columns must be `CAST(… AS CHAR)`** in the
  introspection query — MySQL 8 reports `DATA_TYPE` (and friends) with a **BLOB**
  result type, which sqlx refuses to decode as `String`. The cast forces text.
  (Caught as a regression when type-aware introspection added a `DATA_TYPE` read.)
- Table mode only (v1): needs the column list + types up front. Raw-query /
  multi-table modes are a follow-up.
- Credentials live in the connector's `config` JSONB (localhost v1, plaintext) —
  harden to the RC `.env` or encrypt-at-rest before non-localhost (see the plan).

## Related

- [Backend pillar landing](../index.md)
- [kafka_loader.rs](kafka_loader.md) — the extract→CSV→ingest template
- [connectors route](routes/connectors.md) · [connectors db](db/connectors.md)
