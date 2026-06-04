---
title: tools/doc-gen/gen.js
source: ../../../../../tools/doc-gen/gen.js
owner: Torv
section: Internal · Code · Tools · doc-gen
last modified date: 2026-06-04
---

# doc-gen/gen.js

## Purpose

The **code→doc generator** — the fix for doc **duplication + drift**. Docs rot and
triplicate because they hand-describe things that already have ONE source of truth
(schemas = the live DB / migrations, routes = axum, components = the frontend). The
motivating case: the schema **triplication** — `docs/db/schema.md` (54KB) +
`docs/internal/specs/object-metadata/*.md` (×14) + `docs/objects/*` all describe the
same objects and drift independently.

doc-gen derives the mechanical **"what"** from the single source and writes it into a
**generated region** of the canonical doc. Humans own the **"why / how-it-works /
business-logic"** prose around it. Phase 1 = **schema** (this file).

## Generated regions (the anti-clobber mechanism)

```
<!-- doc-gen:schema:users START — generated from the live DB; do not hand-edit -->
…generated table…
<!-- doc-gen:schema:users END -->
```

`gen.js` only ever rewrites **between** the START/END markers; everything else (human
prose) is preserved. Re-run on a schema change → the table updates, the prose survives
(**idempotent** — verified). You cannot duplicate or drift a schema that's generated
from the one source.

## Public surface

`node tools/doc-gen/gen.js --schema [<table>] | --components  [--out <dir>]`
- `--schema` — schema mode. `<table>` filters to one object; omit → all. Emits per-object
  `<schema>.<table>.md` (generated-region) + `tools/doc-gen/schema.contract.json` (the parity
  baseline for the schema-vs-DB audits). `--out` default `tools/doc-gen/out/schema/`.
- `--components` — **kind=component**: generates the flat UI **catalog index**
  `docs/internal/ui/catalog/index.md` (the complete, code-enumerated component list + the dedup
  worklist) + `tools/doc-gen/component.contract.json`. Source = `tools/lib/fe-inventory.js` (the
  enumerator), NOT the DB. The `ui-doc-audit` gate fails if the index drifts from code.

## How it works (schema phase)

- **Source = read-only live-DB introspection** (`information_schema` + `pg_catalog` via the system
  `psql` — no Node DB dependency, same posture as the shell audits). The live DB is the **exact
  applied state** of all migrations; a static parse of `init.sql` + 9 ALTERs (incl. CHECK/rename
  changes) would be wrong. DSN read from `backend/.env`, with a `:5432→:5433` auto-detect.
- 5 round-trips (tables, columns, constraints, indexes, triggers) → grouped per object → markdown
  (columns table + PK/FK/CHECK/UNIQUE/index/trigger lists) + the JSON contract.
- Base tables **and views** (views labeled "View"); `_sqlx_migrations` + `_`-prefixed internals excluded.

## Drift-prone areas

- **Needs the live DB.** Introspection-based, so it needs DB reach (like `audit_ingest`). If the
  schema doc must regenerate in an environment without the DB, add a migration-replay fallback.
- **Routes are NOT this tool's job** — `tools/lib/rust-routes.js` (the api-doc lane) is the route
  extractor; doc-gen will CONSUME it for the route phase, never re-implement. Shared `doc-gen:`
  marker convention across both.
- **Charts/dashboards are `project_files` subtypes** (`CHT_`/`DSH_` + `spec` jsonb), not tables —
  the generator emits the `project_files` schema; the subtype distinction is human prose.
- **Generated output is gitignored** (`out/`, `schema.contract.json` — regenerable). The canonical
  per-object docs (wired during the rebuild) ARE committed; their generated regions stay tool-owned.

## Related

- Plan: `doc-full-rebuild.md` (the new single internal doc set this seeds) + the doc-tooling layer.
- `tools/lib/rust-routes.js` — the route extractor doc-gen consumes (api-doc lane).
- [Tools pillar landing](../index.md)
