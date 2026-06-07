---
title: Page — SheetWise
section: Internal
last modified date: 2026-06-07
---

# Page — SheetWise

## Purpose

The one question SheetWise answers: **"let me query my data with SQL — and let me
pull more of it in from a live database."** It is two views behind a single rail
toggle: a **SQL console** over the files already in the workspace, and a
**Connectors** surface for reaching into external databases (MySQL today) and
extracting tables into the workspace as CSV.

The page is the design-language pilot, but post-rebuild (CAS_B747F2B6) it carries
**no page-private classes**. It is pure `rp-*` framework composition — the same
`mountRail` / `mountEditorCode` / `mountRedTable` / `mountPager` / `mountChipRow` /
`openModal` every other railed page uses. The page script owns only behaviour and
the `rp-sw-*` *positioning* CSS; every visible block is a framework component. If
a `sw-*` (or any unsanctioned class family) reappears, `tools/uniformity-audit`
fails the build.

## The zero-risk model (why it works the way it does)

The load-bearing invariant, Em's: **the live source is never mutated.** SQL runs
against a read-only substrate, and a connector *copies* a remote table into a CSV
in a project before anyone queries it. Everything destructive is a new artifact:

- A SQL query reads the active source file as table `t` via the read-only
  `POST /api/files/:rid/sql` substrate. Nothing is written.
- "Save target" materializes a result into a **new** file
  (`POST …/sql/materialize`) — the source is untouched, the target is additive.
- A connector pull (`…/sync`) extracts a remote table into a CSV that lands in the
  connector's destination project — RBAC-checked exactly like a file upload,
  because connectors go through the framework upload pipeline, not the storage
  layer. Re-pulling is idempotent; the live database is read-only to us.

Deleting a connector does **not** delete the CSVs it already pulled — they are
ordinary workspace files at that point, and the delete confirmation says so.

## Rail — the SQL ↔ Connectors toggle

The rail (`mountRail` at the shell level) carries the view toggle as its `views`
track: a `rp-rail-views` `data-rail-seg` with two options, **SQL**
(`bi-database-gear`) and **Connectors** (`bi-plug`), persisted under the
`sheetwiseRailView` pref. `switchView` flips the two surfaces
(`#swViewSql` / `#swViewConnectors`) and re-renders the rail groups for the active
view. Connectors are lazy-loaded — the first switch to the Connectors view
triggers `loadConnectors()`, then it is cached.

**SQL view groups** are two static groups:

- **Sources** — the workspace files, filtered to `FIL_*` rids with a non-zero row
  count (empty files would be useless as a query target). Clicking a source =
  `selectTable`: it becomes the active `t`, its columns render as a `mountChipRow`
  (each chip click inserts the column name at the editor caret), and the query
  auto-runs.
- **Targets** — results materialized via "Save target", prepended as you create
  them so the newest is on top.

**Connectors view groups** — each connector is its *own* retractable rail group
(not a flat tab). The group header carries the rename (✎) and delete (✕)
affordances; the group's sub-tabs are the **facets** for the connector's kind
(MySQL: Tables / Schema / Pulls / Settings). Expanding a connector group selects
it and opens its Tables facet by default. When there are no connectors, the group
collapses to an empty-state "New connector" call to action. The rail footer also
carries a "New connector" button — both, plus the empty-state add, open the same
create modal.

The facet set is declared **per kind** (`CONNECTOR_FACETS`), open-ended like the
codec / type registries: MySQL is the template, and a future connector kind
registers its own facets rather than the page branching on `if kind ==`. Per-kind
colour marks (`KIND_MARK`) tint the rail group.

## Surface — SQL view

The SQL surface is the one genuine page-content area, and it too is built from
framework components:

- **Editor** — `mountEditorCode` with `language: "sql"`. The highlighter is purely
  cosmetic (non-executing tokenisation); the real query runs server-side. Run /
  Clear sit in the editor's `actions` slot as `rp-btn-icon`s, and ⌘/Ctrl+Enter
  runs.
- **Result** — `mountRedTable`. Because every query has a different column set, the
  table is **re-mounted per query** (rather than `setColumns`) — the simplest
  correct path for fully-variable result shapes. `null` cells render as `∅`.
- **Pager** — `mountPager`; paging re-runs the last SQL at the new page. The status
  line reports total rows, page N/M, and the server-reported query time.
- **Save target** — names and materializes the last query as a new file; the new
  target appears immediately in the Targets group.

## Surface — Connectors view

The Connectors surface is a **facet router** (`renderFacet`) that renders the
active connector's facet into `#swConnFacet`, with a guidance panel
(`#swConnGuide`) shown until a facet is opened:

- **Tables** — lists the remote database's tables (with approximate row counts);
  each row has a "view schema" button and a one-click "pull → CSV" download
  button.
- **Schema** — columns of a picked table, marking the primary key and showing each
  column's data type and its **projection** (how a non-text type maps to CSV on
  pull). A "Pull <table>" button closes the loop.
- **Pulls** — the files already pulled into this connector's destination project;
  "open" jumps back to the SQL view with that file as the active source.
- **Settings** — read-only summary (name, kind, destination project, connection
  id). Rename/delete live on the rail group header; host/database editing and a
  connection test are noted as arriving with the connector-config endpoint.

A pull (`pullTable` → `…/sync` with a `{table}` override) shows inline
progress/check/error state on the button, refreshes Sources, then jumps to the SQL
view — the pulled CSV is now a queryable source.

## New connector

"New connector" opens `openModal` (modal.js) over the MySQL config fields plus a
**destination-project picker** (the same project-picker model as
`connection-setup.js`): pick an existing project or create one named after the
database. On submit it optionally `POST /api/projects`, then
`POST /api/connectors` (kind `mysql`, the config, the project), then an immediate
`…/sync` to do the first pull. If the first pull fails the connector still exists
and the pull can be retried from its rail group.

Rename and delete hit `PATCH` / `DELETE /api/connectors/:rid` and are Admin+ gated
server-side — the UI affordances are present for everyone, the authorization is
enforced by the backend.

## Notes for the next engineer

- The page keeps a **self-contained `api()` helper** (raw same-origin `fetch`,
  cookie session) rather than the shared client, so its SheetWise-specific 401
  message and the raw `/api/files/:rid/sql` paths stay identical to the proven
  path. That is deliberate, not an oversight.
- Boot order: sync the surface to the persisted rail view, then `loadFiles()`. The
  first source auto-selects and auto-runs `SELECT * FROM t LIMIT 100`.

## Source files

- [pages/sheetwise.js](../code/frontend/scripts/pages/sheetwise.md) — the page script (this page's behaviour).
- [framework/rail.js](../code/frontend/scripts/framework/rail.md) — the rail shell: the SQL↔Connectors toggle, the per-connector retractable groups, rename/delete affordances.
- [framework/editor-code.js](../code/frontend/scripts/framework/editor-code.md) — the SQL editor component.
- [framework/redtable.js](../code/frontend/scripts/framework/redtable.md) — the result grid (re-mounted per query).
- [framework/pager.js](../code/frontend/scripts/framework/pager.md) — the result pager.
- [framework/chip-row.js](../code/frontend/scripts/framework/chip-row.md) — the active source's column chips.
- [framework/modal.js](../code/frontend/scripts/framework/modal.md) — the New-connector create modal.
- [backend/api/routes/files/sql.rs](../code/backend/api/routes/files/sql.md) — the read-only SQL substrate + `…/sql/materialize`.
- [backend/api/routes/connectors.rs](../code/backend/api/routes/connectors.md) — connectors CRUD, `…/tables`, `…/schema`, `…/sync`.
