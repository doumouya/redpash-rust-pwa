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

`POST /api/files/:rid/sql/materialize` — SheetWise's **source→target** write: run
the SQL and persist the result as a NEW project file (the target table), mirroring
the `joins::create_join` materialize path (BlobGuard → compute → summarize/cleanness
→ CsvWriter → `db::insert_file` + audit event). The new file is immediately a
queryable source. The SQL connector will target a DB table the same way.

## Public surface

- `pub(super) async fn execute` — query handler (mounted at `/:rid/sql` in [mod.rs](mod.md))
- `pub(super) async fn materialize` — write-result-as-file handler (`/:rid/sql/materialize`)

## Gates

- **execute** — `file.view` on the primary file (`:rid`) **and** on every extra
  table's `file_id` (`require_view` each). Query-only → view, not Admin. The
  read-only allowlist (`data::sql::is_read_only`) rejects DDL/DML before execution;
  the SQLContext is sandboxed to the registered frames.
- **materialize** — `ensure_owner` on `:rid` (it WRITES a new file to that file's
  project — owner gate, mirroring `create_join`) + `require_view` on every extra table.

## Drift-prone areas

- The primary file is always table `t` (fixed alias) so the GUI-compiler (Phase 3) can emit `FROM t` deterministically and the editor's default template is stable; extra files come via `tables: [{name, file_id}]`.
- A SQL result has a **dynamic schema** — column names ship with the rows (custom `SqlPage`), unlike `/page` (fixed file schema → bare `Page<Row>`).
- `stringify`/`av_to_owned` mirror `group.rs`'s (3rd copy after `parse::page` + `group`); unify into a `data` helper if a 4th consumer appears.
- Errors → 400 for user-fixable SQL issues (syntax / unknown column / unsupported fn / cap exceeded / not-read-only); the Polars message is query/data-only (no secrets).

## Related

- [files/ router](mod.md)
- [data::sql substrate](../../../data/sql.md)
- [SQL-redtable Phase-0 coverage](../../../../specs/sql-redtable/phase-0-coverage.md)
