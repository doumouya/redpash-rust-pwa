---
title: frontend/scripts/pages/database.js
source: ../../../../../frontend/scripts/pages/database.js
owner: Torv
section: Internal · Code · Frontend · scripts · pages
last modified date: 2026-06-07
---

# pages/database.js

## Purpose

The **Database console** page — one of the Admin app's pages (**Slice B2**). A
platform admin browses + runs **READ-ONLY SQL** against a connected Postgres
**through the connector**, and pulls a table → CSV. It's the **dogfood surface**:
do through the app what we'd otherwise do via direct DB access (starting with our
own DB — `127.0.0.1:5433/redpash_prerelease`).

It consumes the live **`POST /api/connectors/:rid/query`** substrate
(platform-admin gated, **READ-ONLY transaction + `statement_timeout` + LIMIT**,
all server-side) plus the connector endpoints SheetWise already uses
(`GET /connectors`, `/:rid/tables`, `/:rid/schema`, `/:rid/sync`,
`/:rid/test`). The **RAIL** lists the Postgres connectors (one tab each) + a
**"Connect a database"** create action (the SheetWise pattern); the **body** shows
the active connector's console — schema explorer + SQL editor + result grid + Pull.

**Slice B2 = READ** (browse + ad-hoc SELECT + pull). The **WRITE** side (a SQL
console for INSERT/UPDATE/DDL) is a separate **role-gated** slice.

## Public surface

- `export default function database(app, { session })` — the router mount.
- **Platform-admin gate.** `session.is_platform_admin` is the first check; a
  non-admin gets the shared denied-surface (`.rp-adm-placeholder`) and the page
  returns before any data call. (The route is also `admin: true` in ROUTES — the
  gate is defence-in-depth, not the sole barrier.)
- **Rail (`mountRail`).** One `Databases` group whose tabs are the Postgres
  connectors (`connGroups()` filters `kind === "postgres"`); the footer + group
  `create`/`groupAdd` all open `openConnectModal`. `tab` → `selectConnector`.
  An empty state still renders the group with a "Connect a database" add label.
- **Body shell (`rp-dbc-*`).** A `bar` (connector name · Test · status), a
  two-pane `body` = tables `aside` | `main` (editbar → error → grid → footer).
  All blocks are framework components; the page owns only the `rp-dbc-*`
  positioning in `styles/admin.css`.
- **Schema explorer** (`loadTables` → `renderTables`): `GET /:rid/tables`
  renders a `rp-dbc-table-list` of buttons (name + approx row count); a click →
  `pickTable`, which seeds the editor with `SELECT * FROM "<ident>" LIMIT 100`
  (only if the editor is empty), enables **Pull**, and loads the table's columns
  (`GET /:rid/schema?table=`) into a `mountChipRow` — a chip click →
  `editor.insertAtCaret(name)`.
- **SQL editor** (`mountEditorCode`, `language: "sql"`): Clear (`rp-btn-icon--ghost`)
  + Run (`rp-btn-icon--accent`) live in its `actions` slot; ⌘/Ctrl+Enter runs.
- **Run query** (`runQuery` → `renderResult`): `POST /:rid/query` with
  `{ sql, limit: DEFAULT_LIMIT }` (200; the backend independently clamps to
  `[1,1000]`). The result re-mounts `mountRedTable` into `#dbcGrid` per query
  (dynamic columns), `null` rendered as `∅`; the footer reports rows · ms · a
  `capped at 200` note when `res.truncated`.
- **Pull** (`pullActiveTable`): `POST /:rid/sync` `{ table }` pulls the selected
  table into a CSV file in the connector's project (RBAC-checked like a file
  upload); the button shows a transient "Pulled → file" confirmation.
- **Connect a database** (`openConnectModal`): a **focused Postgres-only** create
  (the in-app registration) — host / port / user / password / SSL mode
  (`SSL_MODE_OPTIONS`, Required-first secure default) / database / schema /
  destination project (or auto-create a project named after the DB). `onSubmit`
  posts `POST /api/projects` (if new) + `POST /api/connectors`
  (`kind: "postgres"`, `config`) then re-loads + selects the new connector.

## Drift-prone areas

- **Self-contained `api()` helper** (raw same-origin `fetch`, cookie session) —
  kept local so the platform-admin 401 message + raw `/api/connectors/...` paths
  stay identical to the SheetWise-proven path. A 400 from `/query` is surfaced as
  a `Query rejected:` prefix (the read-only substrate rejecting a write/unsafe SQL).
- **READ-only is enforced server-side, not in JS.** The page never tries to parse
  or block SQL — it sends the text to `/query` and surfaces the rejection. Don't
  add a client-side SQL allow/deny list; the READ-ONLY transaction +
  `statement_timeout` + LIMIT are the real guard.
- **Cross-schema QUERY works; cross-schema BROWSE does not.** A schema-qualified
  query (`SELECT * FROM audit.run`) runs fine, but the **Tables** list is
  **single-schema** per the connector's `schema` config (defaults to `public`).
  This is a **known gap, surfaced not hidden** — the empty-tables copy tells the
  admin to use a schema-qualified query, and the Connect modal's schema-field hint
  says queries can still reach other schemas.
- **No page-private role classes — compose the framework COMPONENT.** `rp-dbc-*`
  is positioning ONLY (`-bar` / `-body` / `-tables` / `-table*` / `-main` /
  `-editbar` / `-cols` / `-err` / `-foot` / `-stat`); every interactive block is
  `mountRail` / `mountEditorCode` / `mountRedTable` / `mountChipRow` / `openModal` /
  `rp-btn-icon`. The `tools/uniformity-audit` guard fails on a new unsanctioned
  family.
- **Dynamic redtable columns:** each query has a different column set, so
  `renderResult` re-mounts `mountRedTable` into `#dbcGrid` (`id: "dbcTable"`) per
  query rather than `setColumns` — the simplest correct path for fully-variable
  result shapes. `getCell` reads by `col.key` (`String(columnIndex)`), the same
  positional-array contract SheetWise uses.
- **`DEFAULT_LIMIT` is a UI default, not the cap.** The backend clamps to
  `[1,1000]` independently; the footer's "capped at 200" note keys off
  `res.truncated`, so if the UI default and the comment drift, fix both.

## Related

- [Frontend pillar landing](../../../index.md)
- [pages/sheetwise.js](sheetwise.md) — the sibling connector console this page mirrors (the rail + connector + editor + redtable pattern).
- [editor-code.js](../framework/editor-code.md) · [rail.js](../framework/rail.md) · [redtable.js](../framework/redtable.md) · [chip-row.js](../framework/chip-row.md) · [modal.js](../framework/modal.md) — the composed components.
- [main.js](../main.md) — the router that mounts this at `/database`.
- [routes/connectors.rs](../../backend/api/routes/connectors.md) — the connector + `/query` backend (the read-only substrate).
- [styles/admin.css](../../styles/admin.md) — the `rp-dbc-*` positioning this composition mounts into.
