---
title: backend/crates/api/src/routes/files/sql.rs
source: ../../../../../../../backend/crates/api/src/routes/files/sql.rs
owner: Torv
section: Internal · Code · backend · api · routes · files
last modified date: 2026-06-05
---

# sql.rs

## Purpose

`POST /api/files/:rid/sql` — run a read-only SQL query over the workspace file
(registered as table **`t`**) plus optional extra file-tables, and render the
result through the redtable's `Row` shape. The single SQL surface for Workspace:
the raw editor calls it directly; (later) the GUI builders compile their state to
SQL and hit the same path. Execution + the read-only allowlist live in
`data::sql`; this handler does auth, hydration, the `spawn_blocking` hop, and
result pagination.

## Public surface

- `pub(super) async fn execute` — the route handler (mounted at `/:rid/sql` in [mod.rs](mod.md))

## Gates

- `file.view` on the primary file (`:rid`) **and** on every extra table's
  `file_id` in the body (`require_view` each). Query-only → view, not Admin.
  The read-only allowlist (`data::sql::is_read_only`) rejects DDL/DML before
  execution; the SQLContext is sandboxed to the registered frames.

## Drift-prone areas

- The primary file is always table `t` (fixed alias) so the GUI-compiler (Phase 3) can emit `FROM t` deterministically and the editor's default template is stable; extra files come via `tables: [{name, file_id}]`.
- A SQL result has a **dynamic schema** — column names ship with the rows (custom `SqlPage`), unlike `/page` (fixed file schema → bare `Page<Row>`).
- `stringify`/`av_to_owned` mirror `group.rs`'s (3rd copy after `parse::page` + `group`); unify into a `data` helper if a 4th consumer appears.
- Errors → 400 for user-fixable SQL issues (syntax / unknown column / unsupported fn / cap exceeded / not-read-only); the Polars message is query/data-only (no secrets).

## Related

- [files/ router](mod.md)
- [data::sql substrate](../../../data/sql.md)
- [SQL-redtable Phase-0 coverage](../../../../specs/sql-redtable/phase-0-coverage.md)
