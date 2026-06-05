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
model). Every column is `CAST … AS CHAR` so arbitrary schemas decode uniformly
as strings (no per-type sqlx decode).

## Public surface

- `pub struct Cfg` + `Cfg::from_connection(pool, CON_id)` — reads the `connectors`
  row (kind=`mysql`; destination project + as_user; `config` JSONB = the MySQL
  connection `{conn | host/port/user/password, database, table}`).
- `pub async fn run(pool, data_dir, &Cfg) -> Result<String>` — connect → list
  columns (information_schema) → `SELECT CAST(…AS CHAR)` → CSV → `pipeline::upload_csv`
  → returns the new file rid.

## Drift-prone areas

- **No `db::insert_*`** — must route through `pipeline::upload_csv` (connectors-audit
  red otherwise). The `as_user`'s write-reach is re-checked there (caller_is_admin=false).
- localhost v1 connection: `ssl-mode=DISABLED` (sqlx has no TLS backend feature
  enabled) is allowed **only for loopback** hosts (127.0.0.1 / ::1 / localhost) —
  `from_connection` **rejects a remote host** (it would transport creds + data in
  plaintext). To support remote MySQL, enable a sqlx TLS feature
  (`runtime-tokio-rustls` + `tls-rustls`) + default to `ssl-mode=REQUIRED`.
- Table mode only (v1): the cast-all-to-CHAR needs the column list up front
  (information_schema). A raw-query mode is a follow-up.
- Credentials live in the connector's `config` JSONB (localhost v1, plaintext) —
  harden to the RC `.env` or encrypt-at-rest before non-localhost (see the plan).

## Related

- [Backend pillar landing](../index.md)
- [kafka_loader.rs](kafka_loader.md) — the extract→CSV→ingest template
- [connectors route](routes/connectors.md) · [connectors db](db/connectors.md)
