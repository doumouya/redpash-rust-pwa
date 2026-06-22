# Decision — the object model

The durable why behind RedPash's object layer. Em locked it in the predecessor on
2026-05-22 ("THANKS TEAM! BYE REPORT AND DASHBOARD!!!") after a three-agent design
review converged; the lean rebuild ships the model **clean from the first commit** —
there were never any `reports` / `dashboards` tables to delete. This page is the
*rule*; the schema and resource docs below carry the *shape*. If a future change
feels like it needs a new table, read this first.

This doc was **restored on lean** — it lived at `docs/internal/decisions/object-model.md`
in the predecessor and was dropped in the lean graduation. The rationale is ported
verbatim; every specific (tables, prefixes, views, file paths) is rebuilt against the
lean tree.

## The rule

**A new object exists only for a new SHAPE — never for a new combination of existing
ones.** Salesforce grew a per-vertical object for every business situation; the object
count is its debt. RedPash goes the other way: a small set of orthogonal primitives,
and every "new thing the business needs" is expressed as a *combination* of them (a
row, a tag, a grant, a derived view) rather than a new schema.

A combination that gets its own table can drift from its parts. The bug that triggered
the 2026-05-22 lock proved it: in the predecessor a chart was persisted two ways — a
legacy `reports` table *and* live `project_files` rows — and `project.stage` was
derived off the `reports` table instead of the files, so editing a file stopped
updating the stage. Two storage paths for one concept is two states that must be kept
in sync, and they weren't. The fix wasn't a sync job; it was deleting one of the paths.
Lean inherits the *outcome*, not the bug: there is one storage path per concept by
construction.

## What is actually stored (lean reality, today)

There are no `reports` / `dashboards` tables and no `RPT_` ids — no migration creates
them, no SQL references them ([`init.sql`](../../backend/migrations/20260612000000_init.sql)
line 142: *"no reports/dashboards tables, ever"*). Only these primitives carry state:

- **Entity** — the universal handle. `entities` is the supertype; every top-level
  object's `redpash_id` FKs into it `ON DELETE CASCADE`, so polymorphic relations
  inherit DB-enforced cascade with zero triggers. Every registered type's subtype row
  hangs off it: `users`, `companies`, `teams`, `projects`, `project_files`, `cases`,
  `connectors`, `channels`, `messages`, plus the open `entity_data` store.
- **Project** (`PRJ_`) — a folder. Owns files.
- **File** (`FIL_`) — *every* data artifact is one row in the single `project_files`
  table. A `file_type` CHECK-tags it (`'csv'` / `'chart'` / `'dashboard'`);
  `source_file_id` is the lineage edge back to the file it was produced from.
  "A File is a File" — a chart is a file, a dashboard is a file. Each `file_type` slice
  still mints its **own** unique prefix (`FIL_` / `CHT_` / `DSH_`) so an id resolves to
  a type with no ambiguity — that is day-one #1, below.
- **Step** (`project_steps`, `STP_`) — one cleaning operation in a file's transform
  history. Undo flips `applied` false; the visible frame is always base-parse + replay.
- **Membership** — one polymorphic `(object, member, role, context_role)` edge. Both
  ends FK `entities`, so the *same* table expresses user→project, team→company,
  user→team membership — one primitive standing in for the ≥5 join objects Salesforce
  would mint. It is the entire RBAC layer *and* the org chart.
- **TypeDefinition + entity_data** — the open custom-object store. Builtins keep their
  typed tables; a `type_definitions` row plus an `entity_data` JSONB row is a fully
  RBAC'd, audited, field-validated object with *zero new code* — the generic
  [`objects.rs`](../../backend/crates/api/src/objects.rs) `/api/objects/:type` handler
  is the only reader/writer. Builtins are just "built-in custom objects" sharing the
  same wire shape (S7: the org builtins user/company/team dispatch to their typed
  tables behind that same handler).

## What is NOT stored — derived instead

- **No `reports` / `dashboards` table. No `RPT_` ids.** A project's chart set is
  `project_files WHERE file_type = 'chart'`; its dashboard set is the `'dashboard'`
  slice. The Designer and Publisher surfaces are these derived views — never stored
  keys that can drift from the project id. (`chart` and `dashboard` *are* registered
  `type_definitions` rows so their RIDs resolve and serve field metadata — but the rows
  themselves live in `project_files`, not a separate table.)
- **Chart→dashboard link lives in the dashboard's `spec`**
  (`spec.widgets[].spec.chart_id`, the `project_files.spec` JSONB column). Nothing on
  the chart points up, so a chart sits on any number of dashboards at zero schema cost
  — many-to-many for free. The cost of "link" is a JSON field, not a join table.
- **`project.stage` is a pure function of the files** — the furthest surface reached
  (new / clean / design / publish), computed by the `file_stages` + `project_stages`
  views ([`init.sql`](../../backend/migrations/20260612000000_init.sql), `CREATE VIEW
  file_stages`). Nothing to keep in sync, so it is correct by construction. `publish` =
  a chart built on the file sits on a *public* dashboard; `design` = a chart exists on
  it; `clean` = an applied step exists. Stages mark the furthest surface reached, not a
  forced sequence.

## Why this is the leverage, not just tidiness

The entity layer is deliberately thin so that the part that is actually hard — the
compute (encoding detection, parse, unwrap, auto-clean, cleanness scoring, joins,
group-by, export) — operates on Polars `DataFrame`s in the `data` crate and never
touches the entity layer. The object model could not break the data engine, and a
future object can't either.

Fewer orthogonal primitives is the one-time framework cost that buys a decade of not
paying per-vertical object debt — the disposability moat. The same primitives that ship
a CRM today ship e-commerce or banking tomorrow; only the TypeDefinitions differ. Every
place a closed `if type in {known_list}` appears in framework code is a candidate to
fold back into the open registry — that is the audit lens this decision installs, and
it is exactly the drift [runbook 0011](../internal/runbooks/0011-object-kind-prefix-mismatch.md)
records the predecessor paying for.

## Day-one alignment

This decision is the model behind two locked [day-one](day-one.md) decisions:

- **#1 — RID prefixes are unique per type.** `type_definitions.rid_prefix` is
  `NOT NULL UNIQUE`; `file` / `chart` / `dashboard` share one table yet mint `FIL_` /
  `CHT_` / `DSH_`, so an id resolves to exactly one type with no ordinal tie-break. The
  predecessor shared `FIL_` between file and dashboard and disambiguated by registry
  ordinal — the permanent trap this closes.
- **#2 — Users and files are registered entities from birth.** Both `users.redpash_id`
  and `project_files.redpash_id` FK `entities ON DELETE CASCADE`, so "share one file
  with one person" is just a membership row — the uniform edge, not a special-cased
  cascade arm. The predecessor couldn't express it because files weren't entities.

## Applying the rule to new work

Before adding a table or an id prefix, ask: is this a genuinely new *shape*, or a
*combination* of existing primitives?

- New combination of existing data → a derived view, a `file_type` tag, a `spec` field,
  or a membership grant. No table.
- A custom object a tenant invents → a `type_definitions` seed row + `entity_data` rows.
  Full CRUD / RBAC / audit, zero new code.
- Sharing ("share my charts, not my CSVs") → a grant `(grantee, object, scope, role)`
  keyed on a derived label — a grant is not a property of the shared thing. The
  polymorphic membership edge is already share-ready.
- A genuinely new shape that no combination expresses → a new primitive, and only then.

## Source

- [`schema.md`](../internal/code/backend/schema.md) — the entity supertype registry,
  the type registry, `entity_data` vs. typed tables, the file pipeline tables, and the
  derived stage views
- [`objects.md`](../internal/code/backend/objects.md) — the generic `/api/objects/:type`
  handler over the open store (and the S7 org-builtin dispatch)
- [`rbac.md`](../internal/code/backend/rbac.md) — the polymorphic Membership edge
- [`redpash-id.md`](../internal/code/backend/redpash-id.md) — the prefix → type registry
  and the unique-per-type rule (day-one #1)
- [`day-one.md`](day-one.md) — the locked decisions this model underpins
- [`disposability-requires-a-ledger.md`](disposability-requires-a-ledger.md) — why cheap
  deletion (the moat) needs the ledger that tracks it
- [`init.sql`](../../backend/migrations/20260612000000_init.sql) — the schema: the type
  registry seed, `project_files` (the one File table), and the `file_stages` /
  `project_stages` derived views
- [`objects.rs`](../../backend/crates/api/src/objects.rs) — the one handler set
