---
title: backend/crates/data/src/sql.rs
source: ../../../../../backend/crates/data/src/sql.rs
owner: Torv
section: Internal · Code · backend · data
last modified date: 2026-06-05
---

# sql.rs

## Purpose

Polars-SQL execution substrate — register named in-memory frames, run a
**read-only** SQL query via `SQLContext`, return the result `DataFrame`. The
single execution path behind the Workspace SQL editor (and, later, the
GUI-compiles-to-SQL layer). No external SQL database — Polars lowers SQL to its
own expression engine, sandboxed to the registered frames (no fs / network).

## Public surface

- `pub const SQL_RESULT_ROW_CAP` — result-row ceiling (500k, lockstep with the FE client-engine cap)
- `pub fn run_sql(tables, sql) -> Result<DataFrame>` — register + validate + execute + cap
- `pub fn is_read_only(sql) -> bool` — the allowlist gate

## Drift-prone areas

- `is_read_only` is a conservative allowlist (must start with `SELECT`/`WITH`/`(`; no DDL/DML keyword token; single statement; comments + string-literal contents stripped before the scan so a keyword can hide in neither). Defense-in-depth, not the only guard — the SQLContext has no fs/network reach regardless.
- What Polars 0.43 SQL actually runs is recorded in `docs/internal/specs/sql-redtable/phase-0-coverage.md`. Known-unsupported (route via expressions / rewrite in a later phase): window ranking/nav fns (ROW_NUMBER/RANK/LAG/LEAD/NTILE), INTERSECT/EXCEPT, ROLLUP/CUBE, HAVING-on-a-bare-aggregate, scalar subquery in the SELECT list, constant join conditions (`ON 1=1`).
- Native-only (`#[cfg(not(target_arch = "wasm32"))]`): the wasm32 polars build has no `sql` feature until Phase 5.
- Reproduce the coverage matrix: `cargo +stable run -p data --example sql_spike`.

## Related

- [Backend pillar landing](../index.md)
- [SQL-redtable Phase-0 coverage](../../../specs/sql-redtable/phase-0-coverage.md)
