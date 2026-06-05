---
title: SQL-complete redtable — Phase-0 Polars-SQL coverage matrix
owner: Torv
section: Internal · Specs · SQL-redtable
last modified date: 2026-06-05
---

# Phase 0 — Polars-SQL coverage matrix

De-risking spike for the *"all possible SQL commands in Workspace"* feature
(plan: GUI compiles to SQL + a raw SQL editor, Polars SQL as the single
substrate). Question: **what does Polars 0.43 `SQLContext` actually execute?**

Reproduce: `cargo +stable run -p data --example sql_spike` (throwaway harness at
[examples/sql_spike.rs](../../../../backend/crates/data/examples/sql_spike.rs);
registers two in-memory frames, runs each probe, prints PASS/FAIL).

## Result: 22 / 30 native-or-rewritable, 5 functions need expression emulation

### Works natively on Polars 0.43 SQL (the analytical backbone — free)

`SELECT`/projection · aliased exprs · `WHERE` · `ORDER BY` · `DISTINCT` ·
`LIMIT`/`OFFSET` · `GROUP BY` + aggregates (`COUNT`/`SUM`/`AVG`…) ·
`COUNT(DISTINCT …)` · `INNER JOIN` · `LEFT JOIN` · `CASE WHEN` · scalar
subqueries (`IN (SELECT …)`, derived `FROM (SELECT …)`) · `WITH` CTEs ·
`UNION` / `UNION ALL` · **running-window `SUM(x) OVER (ORDER BY …)`** ·
string fns (`LIKE`, `UPPER`).

### Fails as written, but the construct is SQL-rewritable (all rewrites PASS)

| Construct | Native fail | Rewrite (confirmed PASS) |
|---|---|---|
| `HAVING` | `HAVING SUM(amt) > 100` → can't resolve `amt` post-aggregation | alias the aggregate, filter the alias: `… SUM(amt) AS s … HAVING s > 100` |
| `INTERSECT` | "operation is currently unsupported" | `… WHERE k IN (SELECT k FROM other)` (semi-join) |
| `EXCEPT` / `MINUS` | "operation is currently unsupported" | `… WHERE k NOT IN (SELECT k FROM other)` (anti-join) |
| `ROLLUP` / `CUBE` / `GROUPING SETS` | `Rollup(...) is not currently supported` | `UNION ALL` of each grouping level (each level is a supported `GROUP BY`) |

→ These are handled by **rewriting the SQL before execution**, not by patching
Polars. This is the rust-skill lesson applied: `data/src/sql.rs` becomes a thin
**rewrite/dispatch layer** (register a rewrite for an unsupported construct,
never grow a central `match`), mirroring `codec_registry` / `validate_rules`.

### Truly unsupported — need the Polars **expression** API (not SQL)

The window **ranking / navigation** family: `ROW_NUMBER()`, `RANK()`, `LAG()`,
`LEAD()`, `NTILE()` (`"unsupported function 'row_number'"` etc.). Polars'
expression API has all of them (`int_range`/`cum_count`, `rank`, `shift(±1)`,
`qcut`) via `.over(partition)`, and `report.js` already builds windows this way
— so the in-grid ranking builder emits **Polars expressions**, and the raw-SQL
editor documents these 5 as "use the GUI window builder" for v1 (or we add a
pre-parse that lowers them to expressions in a later phase).

Note: aggregate windows (`SUM/AVG/... OVER`) DO work in SQL — only the
rank/nav functions are missing.

## Design implications (feeds Phase 1)

- **Substrate is viable.** The plan stands: Polars SQL is the single execution
  path; the GUI builders compile to SQL; a raw editor runs SQL; redtable renders.
- **`data/src/sql.rs` = SQLContext wrapper + rewrite registry.** Register each
  project file as a named table → optional rewrite pass (HAVING-alias,
  set-ops→subquery, rollup→union) → execute → return frame (cap + paginate).
- **Window ranking is the one real gap**, and it routes through the existing
  expression-based window path, not SQL.
- Security (Phase 1): allowlist read-only (`SELECT`/`WITH`/set-ops), reject
  DDL/DML; SQLContext is sandboxed to registered frames (no fs/network).

## Toolchain finding (blocks ALL backend builds on the default nightly)

`polars-ops 0.43.1` (pulled by the `strings` feature, used by **both** the
native and wasm32 builds) imports nightly-internal `core::unicode::{Cased,
Case_Ignorable}`, which the **current default nightly (1.98.0, 2026-06-03)**
made private → `error[E0432]/[E0603]`, build fails. The running api binary
predates the nightly drift; the next clean `cargo build` (native *or*
`build-wasm.sh`) fails. The project pins no toolchain and uses **no** nightly
features (`#![feature]`), no `build.rs` — so **stable builds both targets**
(verified: `data` + all deps incl. `polars-sql` compile on stable; stable has
the `wasm32-unknown-unknown` target). Fix = pin the toolchain to stable via
`rust-toolchain.toml`. Until pinned, build with `cargo +stable …`.

(`polars-sql 0.43.1` also emits a `future-incompat` warning — another nudge to
eventually move off the pinned-old polars, tracked separately.)
