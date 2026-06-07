---
title: backend/crates/api/src/mysql_loader.rs
source: ../../../../../backend/crates/api/src/mysql_loader.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-06-07
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

- `pub struct Cfg` (holds `opts: MySqlConnectOptions` + database/table/project/as_user)
  + `Cfg::from_connection(pool, CON_id)` — reads the `connectors` row (kind=`mysql`;
  destination project + as_user; `config` JSONB = `{host, port, user, password,
  database, table, ssl_mode?, ssl_ca?}`). Builds connect options from the discrete
  components (never a format!'d URL); the legacy `conn` full-URL key is **rejected**
  (SSRF). `ssl_mode` (via `parse_ssl_mode`; default loopback→PREFERRED, remote→REQUIRED)
  sets `.ssl_mode(..)`, and an optional `ssl_ca` path sets `.ssl_ca(..)` for VERIFY_CA /
  VERIFY_IDENTITY. The host/TLS admission decision is `host_tls_gate` (see below).
- `pub async fn run(pool, data_dir, &Cfg) -> Result<String>` — connect (pinned
  session) → list columns + `DATA_TYPE` (information_schema) → type-aware `SELECT`
  → stream rows → CSV → `pipeline::upload_csv` → returns the new file rid.
- `project_expr(col, data_type)` / `is_recognized(data_type)` — the single
  type→strategy map (extend here, never branch in `run`); an unrecognized type
  extracts via `CAST AS CHAR` and is `warn!`-logged.
- **Introspection (the connector sub-tabs — Tables / Schema facets):**
  - `connect_pinned(opts)` — the shared secure-connect + SESSION-pin helper; `run`
    + both readers use it (one secure path, no format!'d URL).
  - `pub async fn list_tables(&Cfg) -> Vec<TableInfo>` — `information_schema.tables`
    for the connector's DB (name · `n_rows` estimate · kind BASE TABLE/VIEW). NB
    `rows` is RESERVED in MySQL 8 → the count is aliased `n_rows`.
  - `pub async fn describe_table(&Cfg, table) -> Vec<ColInfo>` — one table's columns
    (name · data_type · nullable · key · `projection` strategy via `projection_label`).
  - `TableInfo` / `ColInfo` (serde) — the JSON the routes return.

## Drift-prone areas

- **No `db::insert_*`** — must route through `pipeline::upload_csv` (connectors-audit
  red otherwise). The `as_user`'s write-reach is re-checked there (caller_is_admin=false).
- **SSRF-hardened connection build (CAS_EC3FF660, 2026-06-07).** Two HIGH SSRF
  fixes: (1) the loopback test is `is_loopback_host` — `host=="localhost"` OR an
  IP literal that `is_loopback()` — NOT the old `starts_with("127.")`, which let
  `127.evil.com` through. (2) connect options are built from discrete components
  via `MySqlConnectOptions::new().host().port().username().password().database()
  .ssl_mode(..)` + `connect_with`, NEVER a `format!("mysql://{user}:{pass}@…")`
  URL — a crafted user/pass could otherwise smuggle a different host through the
  userinfo. The pre-built `conn` URL key is rejected (unbounded host vector).
- **Remote + TLS (Slice A, 2026-06-07).** The connector reaches remote MySQL over
  TLS now that the sqlx `tls-rustls-ring` backend is on (`backend/Cargo.toml`).
  The "loopback-only" rule is replaced by **`host_tls_gate(host, ssl_mode)`**, the
  single admission decision: (a) link-local / cloud-metadata IPs (169.254.0.0/16
  incl. `169.254.169.254`; IPv6 fe80::/10, via `is_blocked_host`) are refused
  **always — even over TLS** (an SSRF pivot, never a real DB); (b) a **remote** host
  must **encrypt** (`ssl_mode ≥ REQUIRED`) — PREFERRED / DISABLED can send plaintext
  so they stay loopback-only. `parse_ssl_mode` defaults an unknown / typo'd mode to
  REQUIRED (never a silent downgrade). The gate + `parse_ssl_mode` + `is_blocked_host`
  + `is_loopback_host` are pure and unit-tested; a `#[ignore]`d live test
  (`mysql_tls_live_required_negotiates`) proves the rustls path actually negotiates
  TLS against the bench. Hostnames pass `is_blocked_host` (the v1 metadata vector is
  the IP literal); re-resolve + re-check at connect if DNS-rebinding becomes a concern.
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
