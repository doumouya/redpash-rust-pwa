---
title: backend/crates/api/src/postgres_loader.rs
source: ../../../../../backend/crates/api/src/postgres_loader.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-06-07
---

# postgres_loader.rs

## Purpose

The **PostgreSQL loader** — the Postgres twin of [mysql_loader](mysql_loader.md):
extract a source table via Rust-native `sqlx` → CSV → `pipeline::upload_csv` (the
framework write — RBAC + parse + `insert_file` + audit, **never** `db::insert_*`).
Thin transport ([[connector-through-framework]]); runs in-process from the connector
"Pull" sync endpoint. Built to the MySQL connector's bar ([[etl-elt-roadmap]] — own
Postgres is the first DB target; Rust-native over JDBC).

## Type-fidelity (the one place the PG type surface is handled)

PostgreSQL's `::text` cast is the **universal, lossless text output**, so `project_expr`
is small — verified faithful on live PG 18.4:

| `udt_name` | projection | result |
|---|---|---|
| `bytea` | `encode("c",'hex')` | clean hex (`deadbeef`; `::text` would give `\xdeadbeef`) |
| `money` | `"c"::numeric::text` | clean fixed-point (`1234.56`; `::text` → locale `$1,234.56`) |
| `geometry`/`geography` (PostGIS) | `ST_AsText("c")` — **conditional, not installed here** | WKT (`::text` → EWKB hex) |
| everything else | `"c"::text` | numeric **exact**, json/jsonb verbatim, arrays `{…}`, uuid, boolean, inet/cidr/macaddr, ranges `[1,5)`, **enum → label**, built-in geometric, all date/time |

Session is pinned **`SET TIME ZONE 'UTC'`** (timestamptz → UTC, verified `+02`→`+00`) +
**`SET bytea_output = 'hex'`**, SESSION scope only (the source's global state is never
mutated). `is_recognized` (incl. array `_*` udt_names) logs an unfamiliar type instead
of silently assuming; `::text` still extracts it.

## Public surface (mirrors `mysql_loader`)

- `Cfg` + `Cfg::from_connection(pool, CON_id)` — reads the `connectors` row
  (`kind="postgres"`), builds `PgConnectOptions` from **discrete components** (never a
  `format!`'d URL — SSRF-safe). Config JSONB: `{host,port,user,password,database,schema?,table}`.
- `run(pool, data_dir, cfg) -> file rid` — connect (pinned) → `information_schema.columns`
  (`udt_name`) → type-aware schema-qualified `SELECT` → stream rows → CSV →
  `pipeline::upload_csv` (`caller_is_admin=false`).
- `list_tables` / `describe_table` — `information_schema` + `pg_class.reltuples`; PK from
  the primary-key constraint. The Tables/Schema facets.
- `qi` (double-quote identifier), `csv_field` (RFC-4180 + NUL strip), `TableInfo`, `ColInfo`.

## Drift-prone areas

**Connection admission is the shared [connectors_core](connectors_core.md) gate, not
local to this file** — so the drift risk is staying in lockstep with it (the MySQL
connector consumes the same gate; a change there must keep this consumer's mapping valid):

- `from_connection` reads the `ssl_mode` config key → `connectors_core::parse_ssl_mode`
  (default: **loopback→`Preferred`, remote→`Required`**), then calls
  `connectors_core::host_gate(host, ssl_mode)` — which refuses link-local / metadata hosts
  **always** and requires a **remote** host to **encrypt** (`Disabled`/`Preferred` stay
  loopback-only; plaintext never leaves the box).
- `pg_ssl_mode` maps the engine-agnostic `SslMode` → `PgSslMode`
  (`Required`→`Require`, `VerifyCa`→`VerifyCa`, `VerifyIdentity`→`VerifyFull`); the
  `ssl_root_cert` / `ssl_ca` config key supplies the CA bundle for the `Verify*` modes.
- The connection is still built from **discrete `PgConnectOptions` components, never a
  `format!`'d URL** (SSRF-safe by construction), and a pre-built `conn` URL is rejected.

So Postgres reaches **remote sources over TLS** exactly like MySQL — the loopback-only
framing is gone (it rode the SQL-connector Torv's `tls-rustls-ring` sqlx feature). The
`routes/connectors.rs` `"postgres"` dispatch is live; the open loader **registry** is the
remaining `connectors_core` co-design item.

## Related

- [mysql_loader.md](mysql_loader.md) — the standard this mirrors.
- [pipeline](pipeline.md) — the framework write (`upload_csv`).
- Plan: `~/.claude/plans/yes-assess-current-situation-cozy-flame.md`; memory [[etl-elt-roadmap]] / [[connector-through-framework]] / [[sqlx-mysql-type-fidelity]].
