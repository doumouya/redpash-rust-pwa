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
  database, table, ssl_mode?, ssl_ca?, columns?, where?, incremental?}`). Builds connect options from the discrete
  components (never a format!'d URL); the legacy `conn` full-URL key is **rejected**
  (SSRF). `ssl_mode` (via `connectors_core::parse_ssl_mode`; default loopback→PREFERRED,
  remote→REQUIRED) maps through `mysql_ssl_mode()` → `.ssl_mode(..)`, and an optional
  `ssl_ca` path sets `.ssl_ca(..)` for VERIFY_CA / VERIFY_IDENTITY. The host/TLS
  admission decision is `connectors_core::host_gate` (see Drift-prone areas).
- `pub async fn run(pool, data_dir, &Cfg) -> Result<String>` — connect (pinned
  session) → list columns + `DATA_TYPE` (information_schema) → **column pushdown**
  (`select_columns`) → type-aware `SELECT` → stream rows → CSV → `pipeline::upload_csv`
  → returns the new file rid.
- **Incremental high-watermark pull** (`config.incremental = {column, last_watermark?}`,
  `struct Incremental`). When set, run() appends `AND (col > ?)` to the composed WHERE —
  the watermark **value is BOUND** (`?`), the column is `qi`-quoted + existence-checked
  against the FULL introspection (it need not be among the pulled `columns`). First pull
  (no `last_watermark`) omits the predicate (full load that seeds the watermark). After a
  **successful** upload of a **non-empty** delta, run() re-queries `MAX(col)` over the same
  predicate and persists it via `db::set_connector_watermark` (surgical `jsonb_set` of
  `config.incremental.last_watermark`). Advancing only post-upload means a failed upload
  never skips rows. Caveats: the watermark column should be **temporal or auto-increment**
  (text comparison must be monotone — a non-padded numeric string sorts lexicographically
  wrong); two concurrent syncs can regress the watermark (row-atomic, not compare-and-set)
  — both acceptable for v1 operator-triggered sync, documented for hardening.
- `sanitize_where(raw)` — validates the optional `config.where` predicate pushdown.
  `config.where` is an **operator-trust boundary**, not an injection-safe input: the
  operator already chose the source table + the (least-privilege) creds the read runs
  under, so an arbitrary boolean predicate is by design. `sanitize_where` trims (empty →
  no filter) and applies **defense-in-depth** guards — reject `;`, `--`, `/* */`, cap
  length 4096 — then run() appends `WHERE (<expr>)` (parenthesized for incremental
  composition) and **dry-runs** it (`SELECT 1 … WHERE (<expr>) LIMIT 0`) so a syntax
  error is a clean error before the pull streams. NOTE: a per-pull `where` override must
  not be accepted from a non-admin sync caller (deferred — FE exposure is Admin-gated).
- `select_columns(all, want)` — applies the optional `config.columns` pushdown:
  `None` = all columns; else keep only the requested ones in **ordinal** order,
  case-insensitively, **existence-checked against the live introspection** (an unknown
  name or an empty list errors). Pure + unit-tested; run() applies it to the introspected
  list so the select list only ever emits qi-quoted introspected names — a bogus/injected
  config name is rejected, never concatenated into SQL.
- `project_expr(col, data_type)` / `is_recognized(data_type)` — the single
  type→strategy map (extend here, never branch in `run`): spatial → EWKT
  (`CONCAT('SRID=',ST_SRID,';',ST_AsText)`), binary → `HEX`, `bit` → unsigned-int
  text, **`float` → `CAST(CAST(.. AS DOUBLE) AS CHAR)`** (full precision), everything
  else → `CAST AS CHAR`. Every arm yields a STRING (run() decodes each column as
  `Option<String>`). An unrecognized type extracts via the `CAST AS CHAR` default and
  is `warn!`-logged.
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
  The "loopback-only" rule is replaced by a host/TLS admission gate: a **remote** host
  must **encrypt** (`ssl_mode ≥ REQUIRED`) — PREFERRED / DISABLED can send plaintext so
  they stay loopback-only — and link-local / cloud-metadata hosts are refused **always,
  even over TLS**. An `#[ignore]`d live test (`mysql_tls_live_required_negotiates`)
  proves the rustls path actually negotiates TLS against the bench.
- **Gate delegated to `connectors_core` (Slice A2, 2026-06-07 — CAS_A0BDFCED / runbook
  0012).** The admission gate + `ssl_mode` parse no longer live here: `from_connection`
  calls **`connectors_core::{parse_ssl_mode, is_loopback_host, host_gate}`** (the ONE
  reviewed copy shared with `postgres_loader`), and `mysql_ssl_mode()` maps the
  engine-agnostic `connectors_core::SslMode` → `MySqlSslMode` for the sqlx option. This
  closed a class of SSRF **encoding bypasses** the local Slice-A gate missed —
  IPv4-mapped (`::ffff:169.254.169.254`), IPv4-compatible, NAT64 (`64:ff9b::…`),
  zoned (`fe80::1%eth0`), trailing-dot, and `0.0.0.0`/`::` — because the core classifies
  the address the kernel routes to, not the textual form. Add SSRF/ssl rules in
  `connectors_core`, never re-fork them here. The `conn` full-URL key is still rejected
  + connect options still built from discrete components (no `format!`'d URL).
- **Type-aware projection lives in `project_expr`** — the ONE place MySQL's type
  surface is mapped. Add a type there; never branch in `run`. `is_recognized`
  `warn!`s an unmapped type so a new MySQL type surfaces instead of silently
  mangling (`CAST AS CHAR` is the safe default).
- **Type-fidelity contract (Slice B, 2026-06-07 — CAS_A968E1D0 / runbook
  CAS_A968E1D0…-mysql-typefidelity).** Empirical bench audit closed two **silent
  data-loss** gaps: **FLOAT** rendered ~6 sig digits via direct `CAST AS CHAR` (can't
  round-trip binary32) → now `CAST(CAST(.. AS DOUBLE) AS CHAR)`; **spatial** `ST_AsText`
  dropped the SRID (SRID=4326 ≡ SRID=0) → now EWKT `CONCAT('SRID=',ST_SRID,';',ST_AsText)`.
  Remaining losses are **storage-layer, NOT projection-recoverable** — documented as a
  contract, not bugs: **JSON** is emitted MySQL-normalized (object keys reordered, dup
  keys dropped at INSERT, `:`/`,` spacing) — exact-byte/hash/signature consumers must not
  assume input bytes; **CHAR(N)** trailing spaces are stripped on read (PAD SPACE) — use
  VARCHAR/TEXT if trailing space is data; **BIT** emits the integer value (declared width
  not preserved); **SET** emits members in definition order; **TIMESTAMP** is rendered
  in UTC (session-pinned). FLOAT→DOUBLE and spatial→EWKT are unit-tested + bench-verified
  (`0.3333333432674408` vs `0.333333`; `SRID=4326;…` vs `SRID=0;…`). DOUBLE stays on the
  default arm (faithful except a narrow DBL_MIN-subnormal edge). VECTOR (MySQL 9) is
  unprobed — deferred; the open-ended default arm still extracts it.
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
