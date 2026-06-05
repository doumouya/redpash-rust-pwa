---
title: "MySQL connector pull of geometry/binary tables crashed on a NUL byte"
order: 16
case_id: CAS_082A124FC4F7499CAD3805C267DE3437
section: Internal
severity: Sev2
last modified date: 2026-06-05
owner: Torv
---

# 0016 — MySQL connector: a NUL byte from `CAST(geometry AS CHAR)` aborted `insert_file`

## Problem Statement

Pulling a MySQL table that has a `GEOMETRY` (or binary/`BLOB`) column via the SheetWise
connector — e.g. `sakila.address` — failed with `upload to project: internal database
error` (HTTP 400). Scalar-only tables (`employees`, `departments`) pulled fine. Surfaced by
Em testing the connector on 2026-06-05. The error was invisible in the UI (only a
`console.error`), so it first looked like an auth/cache problem ("maybe because I'm on
Google Auth").

## Troubleshooting steps

1. Read the console errors: `upload to project: internal database error` (repeated on
   `sakila.address`) and `table sakila.sakila not found` — the latter is benign (the db
   name typed into the *table* field).
2. Reproduced the loader's projection + decode at the sqlx level (throwaway probe): every
   `address`/`film`/`city` column decodes cleanly as `Option<String>` once the
   `information_schema` columns are `CAST(... AS CHAR)`. This refuted the first hypothesis
   (`ST_AsText` returning a binary type) — the failure is *after* extraction, in the upload.
3. Noted the loader's `map_err` keeps only `e.message`, so the events table held the
   redacted "internal database error" — the true cause was only in the Postgres server log.
4. Read `/var/log/postgresql/postgresql-18-main.log`:
   `ERROR: unsupported Unicode escape sequence` / `DETAIL: U+0000 cannot be converted to
   text` / `STATEMENT: INSERT INTO project_files`.
5. Correlated the timeline: `address` (geometry) fails, `employees`/`departments` (scalar)
   succeed — the NUL is tied to the geometry column.

## RCA

The pre-fix loader projected every column as `CAST(col AS CHAR)`. On a `GEOMETRY` column
that yields the raw **WKB** byte string (SRID prefix + well-known binary), which is full of
NUL bytes (U+0000). Those bytes flowed into the file's column-sample metadata, and the
framework write (`db::insert_file`) stores that metadata as Postgres `text`/`jsonb` —
**Postgres cannot store U+0000 in `text`/`jsonb`** and aborts the INSERT ("unsupported
Unicode escape sequence"). Scalar tables never emit a NUL, so they were unaffected. The
opaque "internal database error" plus the FE swallowing the message into the console is why
it first read as an auth/cache issue.

Secondary (latent, caught en route): the type-aware introspection added a read of
`information_schema.columns.DATA_TYPE`, which MySQL 8 returns with a **BLOB** result type;
sqlx refuses to decode that as `String` ("Rust type String ... not compatible with SQL type
BLOB"), which would panic the loader on any non-empty table.

## Solution

- **Type-aware projection** (`mysql_loader::project_expr`, shipped `e918c90`): geometry →
  `ST_AsText` (WKT, e.g. `POINT(-112.81 49.69)`), binary/blob → `HEX`, `bit` → unsigned-int
  text, else `CAST AS CHAR`. Keeps NUL-laden bytes out *at the source* — geometry lands as
  clean WKT.
- **NUL-strip in `csv_field`** (`ec06e18`): every emitted value drops `'\0'`.
  Defense-in-depth for the whole "NUL aborts `insert_file`" class — any column/type/future
  connector, not just geometry. Postgres `text`/`jsonb` can never hold NUL, so stripping it
  (rather than failing the pull) is the safe contract.
- **`CAST(... AS CHAR)` on the introspection query** (`ec06e18`) — defeats the MySQL-8
  `DATA_TYPE` BLOB result type so both `column_name` and `data_type` decode as `String`.
- **FE** (`10ef2fa`): connector pull errors now surface in an inline `#swConnErr`
  `role="alert"` box instead of only `console.error`. A backend error invisible to the user
  is a UX failure — that invisibility is what let the opaque DB error masquerade as an auth
  issue.
- **Deferred:** the loader's `map_err` still flattens the upload `AppError` to its
  `message`, dropping the inner chain — the real Postgres error reached only the PG log, not
  the events table. Preserving the chain through the connector path is a follow-up
  (observability gap), and a pipeline-level NUL guard would cover non-connector uploads too.

## Post Checking

- 7 `mysql_loader` unit tests pass (incl. `csv_field` strips NUL; `project_expr` per type);
  `cargo clippy -p api` clean.
- sqlx probe vs live MySQL 8.4: `sakila.address`/`film`/`city` project + decode clean,
  geometry → `POINT(...)` WKT, no NUL; the old `CAST(geometry AS CHAR)` path reproduced the
  WKB NUL bytes (`HEX` = `0000000001010000...`).
- **Confirmed live by Em** after rebuild + restart: `sakila.address` pulls, `location`
  column = `POINT(-112.8185647 49.6999986)`.
- Branch `prerelease`: `e918c90` (type-aware base) → `ec06e18` (NUL strip + i_s-BLOB CAST) +
  `10ef2fa` (FE alert), pushed.
