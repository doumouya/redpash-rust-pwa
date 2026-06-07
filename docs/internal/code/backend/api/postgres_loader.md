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

## Security (v1) + the shared-core fold-in

v1 is **loopback-only / `ssl-mode=disable`** (sqlx 0.8 has no TLS backend yet) — the local
`is_loopback_host` gate rejects non-loopback hosts (same posture as the MySQL connector
pre-TLS). **Remote + TLS, the `ssl_mode` ladder, the SSRF-for-remote guard, and
credential-at-rest land via a shared `connectors_core`** co-designed with the SQL-connector
Torv's TLS slice (their `tls-rustls` feature unblocks Postgres too); at that point this
file's `is_loopback_host` folds into `connectors_core::host_gate(host, ssl_mode)`. The
`routes/connectors.rs` `"postgres"` dispatch is wired then (via the proposed loader registry).

## Related

- [mysql_loader.md](mysql_loader.md) — the standard this mirrors.
- [pipeline](pipeline.md) — the framework write (`upload_csv`).
- Plan: `~/.claude/plans/yes-assess-current-situation-cozy-flame.md`; memory [[etl-elt-roadmap]] / [[connector-through-framework]] / [[sqlx-mysql-type-fidelity]].
