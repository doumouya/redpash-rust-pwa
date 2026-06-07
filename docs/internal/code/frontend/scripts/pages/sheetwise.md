---
title: frontend/scripts/pages/sheetwise.js
source: ../../../../../frontend/scripts/pages/sheetwise.js
owner: Torv
section: Internal · Code · Frontend · scripts · pages
last modified date: 2026-06-07
---

# pages/sheetwise.js

## Purpose

The **SheetWise** page — the SQL console (view 1) + the Connectors view (view 2),
**conformed to the canonical rail-shell** (CAS_B747F2B6, 2026-06-05). It originally
shipped as the design-language pilot but forked a bespoke `sw-*` class family;
this rebuild deletes that family and **composes framework components** —
`mountRail` / `mountEditorCode` / `mountRedTable` / `mountPager` / `mountChipRow` /
`openModal` — exactly like every other railed page. The page owns only behaviour
+ the `rp-sw-*` POSITIONING in `styles/sheetwise.css` (the `rp-cases-*` convention).

## Public surface

- `export default function sheetwise(app, { session })` — the router mount.
- **Rail (`mountRail` at the shell level)** carries the **SQL ↔ Connectors toggle**
  as its `views` track (`rp-rail-views` `data-rail-seg`, persisted under the
  `sheetwiseRailView` pref — the standardized toggle, not a bespoke seg) + the
  per-view groups; `switchView` flips the surface (`#swViewSql`/`#swViewConnectors`)
  and re-renders the groups via `rail.setGroups`.
  - **SQL view groups:** Sources (files → `rp-rail-tab`, click = `selectTable`) +
    Targets (materialized results). The active file's columns render as a
    `mountChipRow`; a chip click → `editor.insertAtCaret(name)`.
  - **Connectors view: each connector is its OWN retractable `rp-rail-group`** (db
    mark, `KIND_MARK` per engine), and its **sub-tabs are the kind's facets**
    (`CONNECTOR_FACETS`, open-ended per kind; MySQL + PostgreSQL share `SQL_FACETS` =
    Tables / Schema / Pulls / Settings, since the backend dispatches on `conn.kind`).
    Rename/delete
    ride the group affordances (`groupRename`→`PATCH`, `groupHide`→`DELETE` with a
    confirm); `groupAdd`/footer create → `openNewConnectorModal`. Expanding a
    connector (`groupToggle`) opens its **Tables** facet.
  - **Facet surface router** (`renderFacet` → `#swConnFacet`): **Tables**
    (`GET /:rid/tables` → browse + per-table Pull via `pullTable` = `sync {table}`;
    click a table name → Schema), **Schema** (`GET /:rid/schema?table=` → columns +
    types + projection strategy), **Pulls** (the connector's project files via
    `/api/files`), **Settings** (summary info + a **Test connection** button →
    `POST /:rid/test` → `mysql_loader::probe`, result in `#swConnTestStat`
    `.is-ok`/`.is-err`; host/db editing still lands with the config endpoint). The
    guidance (`#swConnGuide`) shows until a facet is open.
- **SQL surface:** `mountEditorCode` (the editor; Run/Clear are `rp-btn-icon` in its
  `actions` slot, ⌘/Ctrl+Enter runs) → `mountRedTable` (result, re-mounted per query
  since columns are dynamic; `getCell` renders `null` as `∅`) → `mountPager`. Save-as-
  table materializes via `POST …/sql/materialize`.
- **New connector:** the connectors-guide CTA is **two engine-specific Add buttons,
  each with its brand logo** (`#swConnNewPg` 🐘 PostgreSQL, `#swConnNewMy` 🐬 MySQL —
  `frontend/icons/connectors/{postgres,mysql}.png`). Each calls
  `openNewConnectorModal(kind)`, which is **engine-aware**: given a `kind` it LOCKS the
  engine (no Engine picker; title "New <Engine> connector"; port/user defaults from
  `ENGINE_META` = 3306/`root` vs 5432/`postgres`; the **schema** field shows only for
  postgres). Called with no `kind` (the rail's generic add) it falls back to showing the
  **Engine** picker. Other fields: host, an **SSL mode** select (`SSL_MODE_OPTIONS`,
  Required-first = secure default), password, database, table, destination-project picker
  (the `connection-setup.js` pattern). `onSubmit` posts `{ kind, config }` — `config`
  carries `ssl_mode` (default `"required"`, read by both loaders) and, for postgres,
  `schema`. The Tables/Schema/Pulls facets are kind-agnostic (backend dispatches on
  `conn.kind`), so postgres connectors use the same surface. Flow: `POST /api/projects`
  (new-project path) +
  `POST /api/connectors` + `…/sync`. The Settings facet notes that host / DB / SSL mode
  editing + a connection test arrive with the connector-config endpoint (deferred —
  config isn't in the list payload).

## Drift-prone areas

- **Self-contained `api()` helper** (raw same-origin `fetch`, cookie session) — kept
  local so the SheetWise-specific 401 message + raw `/api/files/:rid/sql` paths stay
  identical to the proven path.
- **Zero-risk model (Em):** a connector copies the source into a CSV; SQL runs on the
  copy; the live source is read-only. Pull/re-pull is idempotent.
- **The editor is the one genuine page-content surface — but it's a COMPONENT now**
  (`framework/editor-code.js`, `rp-editor*`/`rp-tok-*`), not a `sw-*` re-skin. Language
  is parameterized (`language: "sql"`); the highlighter is cosmetic (non-executing).
- **No page-private classes.** Everything is `rp-*` (framework) or `rp-sw-*`
  (positioning only). The `tools/uniformity-audit` guard fails the build if a `sw-*`
  (or any unsanctioned family) reappears — see [uniformity-audit](../../../tools/uniformity-audit/audit.md).
- **Dynamic redtable columns:** each query has a different column set, so `renderResult`
  re-mounts `mountRedTable` into `#swGrid` rather than calling `setColumns` — simplest
  correct path for fully-variable result shapes.

## Related

- [Frontend pillar landing](../../../index.md)
- [editor-code.js](../framework/editor-code.md) · [rail.js](../framework/rail.md) · [redtable.js](../framework/redtable.md) · [pager.js](../framework/pager.md) — the composed components.
- [main.js](../main.md) — the router that mounts this at `/sheetwise`.
- [files/sql route](../../backend/api/routes/files/sql.md) · [routes/connectors.rs](../../backend/api/routes/connectors.md) — the backends.
