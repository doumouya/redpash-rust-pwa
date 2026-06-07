---
title: Decision — the object model
section: Internal
last modified date: 2026-06-07
---

# Decision — the object model

The durable why behind RedPash's object layer. Em locked it on
2026-05-22 ("THANKS TEAM! BYE REPORT AND DASHBOARD!!!") after a
three-agent design review converged. This page is the *rule*; the
per-DTO survival docs below are the *shape*. If a future change feels
like it needs a new table, read this first.

## The rule

**A new object exists only for a new SHAPE — never for a new
combination of existing ones.** Salesforce grew a per-vertical object
for every business situation; the object count is its debt. RedPash
goes the other way: a small set of orthogonal primitives, and every
"new thing the business needs" is expressed as a *combination* of them
(a row, a tag, a grant, a derived view) rather than a new schema.

A combination that gets its own table can drift from its parts. The
bug that triggered the 2026-05-22 lock proved it: a chart was persisted
two ways — the legacy `reports` table *and* live `project_files` rows —
and `project.stage` was derived off the `reports` table instead of the
files, so editing a file stopped updating the stage. Two storage paths
for one concept is two states that must be kept in sync, and they
weren't. The fix wasn't a sync job; it was deleting one of the paths.

## What is actually stored (reality, today)

The dead `reports` and `dashboards` tables are gone — there are no
migrations creating them and no SQL referencing them. Only these
primitives carry state:

- **Entity** — the universal handle. `entities` is the supertype; every
  top-level object's `redpash_id` FKs into it `ON DELETE CASCADE`, so
  polymorphic relations inherit DB-enforced cascade with zero triggers.
  Types today: `user`, `company`, `project`, `case`, `team`.
- **Project** (`PRJ_`) — a folder. Owns files.
- **File** (`FIL_`) — *every* artifact is one row in the single
  `project_files` table. A `file_type` tags it (`csv` / `chart` /
  `dashboard` / export kinds); `source_file_id` is the lineage edge back
  to the file it was produced from. "A File is a File" — a chart is a
  file, a dashboard is a file, a PNG export is a file.
- **Step** (`project_steps`, `STP_`) — one cleaning operation in a
  file's transform history.
- **Membership** — one polymorphic `(subject, object, role, context)`
  edge. Subject and object both FK `entities`, so the *same* table
  expresses user→project, team→company, user→team membership — one
  primitive standing in for the ≥5 join objects Salesforce would mint.
- **TypeDefinition + entity_data** — the open custom-object store.
  Builtins keep their typed tables; a TypeDefinition plus an
  `entity_data` JSONB row is a fully RBAC'd, audited, field-validated
  object with *zero new code* (the generic `/api/objects/:type` handler
  is the only reader/writer). Builtins are just "built-in custom
  objects" — same serialization path.

## What is NOT stored — derived instead

- **No `reports` / `dashboards` table. No `RPT_` / `DSH_` ids.** A
  project's chart set is `project_files WHERE file_type='chart'`; its
  dashboard set is the `'dashboard'` slice. The **Designer** and
  **Publisher** surfaces are these derived views — never stored keys
  that can drift from the project id. `RPT_999` / `DSH_999` survive at
  most as URL labels for `PRJ_999`'s slices.
- **Chart→dashboard link lives in the dashboard's `spec`**
  (`spec.widgets[].spec.chart_id`). Nothing on the chart points up, so a
  chart sits on any number of dashboards at zero schema cost —
  many-to-many for free. The cost of "link" is a JSON field, not a join
  table.
- **`project.stage` is a pure function of the files** — the furthest
  surface reached (New / Clean / Design / Publish), computed by the
  `file_stages` view. Nothing to keep in sync, so it is correct by
  construction. Publish = the project has ≥1 *public* dashboard-file.
  Stages mark the furthest surface reached, not a forced sequence: a
  project can jump straight to Design if the imported file is already
  clean.

## Why this is the leverage, not just tidiness

The entity layer is deliberately thin so that the part that is actually
hard — the compute (encoding detection, parse, unwrap, auto-clean,
cleanness scoring, joins, group-by, export) — operates on Polars
`DataFrame`s and never touches the entity layer. The object refresh
could not break the data engine, and a future object can't either.

Fewer orthogonal primitives is the one-time framework cost that buys a
decade of not paying per-vertical object debt. The same five primitives
that ship a CRM today ship e-commerce or banking tomorrow — only the
TypeDefinitions differ. Every place a closed `if type in {known_list}`
appears in framework code is a candidate to fold back into the open
registry; that is the audit lens this decision installs.

## Applying the rule to new work

Before adding a table or an id prefix, ask: is this a genuinely new
*shape*, or a *combination* of existing primitives?

- New combination of existing data → a derived view, a `file_type`
  tag, a `spec` field, or a membership grant. No table.
- Sharing ("share my charts, not my CSVs") → a future `shares` grant
  `(grantee, project, scope, file_id?, role)` keyed on a derived
  label — a grant is not a property of the shared thing. Parked with
  the RBAC workstream; the post-refresh model is already share-ready.
- A genuinely new shape that no combination expresses → a new
  primitive, and only then.

## Source files

- [backend/crates/shared/project.md](../code/backend/shared/project.md) — the Project DTO
- [backend/crates/shared/file.md](../code/backend/shared/file.md) — the one File row every artifact lives in
- [backend/crates/shared/chart.md](../code/backend/shared/chart.md) — chart as a file (`/api/charts`)
- [backend/crates/shared/dashboard.md](../code/backend/shared/dashboard.md) — dashboard as a `'dashboard'`-typed file
- [backend/crates/shared/report.md](../code/backend/shared/report.md) — no stored Report; the `/api/group/preview` grouping spec
- [backend/crates/shared/step.md](../code/backend/shared/step.md) — the per-file cleaning Step
- [backend/crates/shared/type_def.md](../code/backend/shared/type_def.md) — TypeDefinition: builtins as built-in custom objects
- [backend/crates/api/db/entities.md](../code/backend/api/db/entities.md) — the entity supertype registry
- [backend/crates/api/routes/group.md](../code/backend/api/routes/group.md) — `/api/group/preview`, the stateless grouping engine (ex-`/api/reports`)
- [backend/crates/api/routes/objects.md](../code/backend/api/routes/objects.md) — the generic `/api/objects/:type` handler over the open store
- [backend/crates/api/rbac.md](../code/backend/api/rbac.md) — the polymorphic Membership edge
