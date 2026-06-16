# The Data Cleaner (`apps/studio/workspace`)

The Data Cleaner is the `workspace` page of the `studio` app (route `#/workspace`,
visible label "Data Cleaner"). Its entry file is a **thin orchestrator** over the
composable framework primitives (see [`components.md`](components.md)): it owns
the data lifecycle, the resident wasm engine, the `/steps` source-of-truth
contract, and the interaction modes — the look lives entirely in framework
components. The toolbar, the clean ops, and the report vocabulary are expressed
as **data** in three sibling spec files.

## Current build state

| Phase | Status | What |
|---|---|---|
| **DC1** | ✅ done (`9ddb028`) | App-wide responsive foundation: breakpoint tokens, the rail off-canvas drawer (scrim + matchMedia), responsive chrome down to 1024×768 |
| **DC2** | ✅ done (`6243501`) | The composable grid (`grid-toolbar`/`grid-view`/`side-panel`/`workspace-panels`), the 3-panel shell, redtable edit/select/delete modes, the `clean-catalog`/`toolbar-spec` data files |
| **DC3a** | ✅ done (`2765f4f`) | The **Report tab** — `report-builder` + `report-spec`, `POST /api/group/preview`, preview swaps the wide center |
| **DC3b** | ⏳ pending | Deep **column-manager + action-sheet** consuming the full `clean-catalog.js` (cast/fill/replace/split/rename per selected column) |
| **DC3c** | ⏳ pending | **Nested AND/OR filter groups** (the `FilterNode` tree + `apply_filter` are already recursive — frontend-only) |

> **DC3 needs no new backend.** `POST /api/group/preview` (reports) and `POST
> /api/files/:rid/steps` (every clean op) already exist; nested filters use the
> existing recursive `FilterNode`. The earlier plan's "2 wasm wrappers" are
> unnecessary. See [`backend.md`](backend.md).

## The 3-panel layout

```
┌ topbar: ☰  RedPash   [ omnisearch ]   apps  user ─────────────────────────┐
├ rail ┬ LEFT side-panel ─┬ CENTER ───────────────────┬ RIGHT side-panel ────┤
│ (gl. │ [ Filter |Report]│ score · filename · N rows │ [ Clean|Joins|Hist ] │
│ nav) │                  │ ┌ grid-toolbar ─────────┐ │                      │
│      │ filter rows /    │ │ upload filter ✎☑🗑 ↶↷… │ │ clean ops            │
│      │ report builder   │ ├ redtable ─────────────┤ │ joins wizard         │
│      │                  │ │ data grid             │ │ steps history        │
│      │                  │ └───────────────────────┘ │                      │
└──────┴──────────────────┴───────────────────────────┴──────────────────────┘
```

Wrapped in `workspace-panels`: inline 3-region grid ≥ 80rem; below that the side
panels become off-canvas drawers over a scrim (one at a time), so the whole tool
stays usable down to the 1024×768 floor. The **center has two stacked panes** —
the data view (score + grid) and a report view (a bare grid-view) — one visible at
a time; running a report swaps to the report pane, "Back to data" swaps back.

## Files

| File | Role |
|---|---|
| `workspace.js` | Orchestrator: `mount`, render branches, data lifecycle, engine, modes, dispatch |
| `clean-catalog.js` | The clean-op palette as data (the discoverability artifact) — **not yet wired** (DC3b) |
| `toolbar-spec.js` | The main toolbar as `state → controls` |
| `report-spec.js` | `AGG_FNS` vocabulary + `buildReportSpec` |
| `workspace.css` | Page-scoped only (`.pg-studio-workspace-*`); never touches a framework `.rp-` class |
| `framework/report-builder/` | Product-agnostic group-by + measures form (owns `.rp-rb*`) |
| `framework/engine/wasm-engine.js` | Lazy loader for the dual-surface (client = server) data engine |

---

## 1 — Orchestrator structure (`workspace.js`)

```js
export default async function mount(root, ctx) { … return { destroy: () => destroyPage() }; }
```

Reads the session via `ctx.getSession()`, parses an optional `?file=<rid>`
deep-link off `location.hash`, and ends by opening the deep-linked file or
rendering empty. Two render branches, each preceded by `destroyPage()`:

- **`renderEmpty()`** — the Overview / upload landing. `assemblePage` with `sections:[{key:"main"},{key:"recents", title:"Recent files"}]`; mounts the `uploader` into `main` and a recent-files redtable into `recents`.
- **`renderLoaded()`** — the loaded 3-panel cleaner. `assemblePage` with `sections:[{key:"work"}]`, then `panels = mountWorkspacePanels(page.section("work"))`. LEFT `side-panel` [Filter|Report]; CENTER `dataPane` (score-badge + grid-view) ⇆ `reportPane` (bare grid-view); RIGHT `side-panel` [Clean|Joins|History].

**Rail integration** (`railSpec`): an `overview` pseudo-tab (`bi-magic`, active
when no file is open) whose `onSelect` calls `renderEmpty()`; an `onRailTab` that
opens file tabs in place; reports the active `rid`.

## 2 — Data lifecycle

All persistent state is on the server; the orchestrator mutates through endpoints
and re-reads. (`api.*` prefixes `/api`; raw `location.href`/`fetch` spell out
`/api/...`.)

- **`openFile(rid)`** — `GET /files/:rid` summary → reset view state (`filterNode=null`, `mode="browse"`, clear selection + hidden cols, `freeWorkbook()`) → `renderLoaded()` → parallel `renderView()` + `refreshSteps()` → set score → **background** `loadResidentEngine(rid)`.
- **`uploadFile(file)`** — instant **on-device** score via `clientParseScore` (bytes never leave the device) → `api.upload("/files", fd)` → toast server score → `invalidateRailData()` → `openFile(out.rid)`.
- **`renderView()`** — paints the center grid. Filtered → prefer the resident engine `wb.filter_page(...)` (when `wbRid === current.rid`), else `POST /files/:rid/page {offset,limit,filter}`. Unfiltered → `GET /files/:rid/page?offset=0&limit=<n>`. Builds the meta string ("X of Y rows match" vs "showing first N of M"); page size from the `workspace.page_rows` pref (default **1000**).
- **`afterMutation()`** — the **server-is-truth + reload-engine** pattern after every frame-changing op:
  ```js
  freeWorkbook();                                                  // resident engine now stale
  await Promise.all([renderView(), refreshScore(), refreshSteps()]); // repaint from server
  loadResidentEngine(current.rid);                                 // re-warm for next time
  ```

## 3 — Resident wasm engine (`framework/engine/wasm-engine.js`)

Lazy: cold visitors pay zero bytes; the first call streams + compiles the
content-hashed wasm. "One engine, two surfaces" — the client score is
byte-identical to the server's for the same bytes.

- `loadWorkbook(bytes, tld)` → `Workbook.from_csv(...)`; `loadResidentEngine` fetches the file as CSV (`GET /files/:rid/export?format=csv`), loads it, frees any old workbook, stores `wb`/`wbRid`.
- `clientParseScore(bytes)` → the instant on-upload score.
- The resident `Workbook` exposes `.page`/`.filter_page`/`.score`/`.rows`/`.cols`, each returning a **JSON string** the caller `JSON.parse`s. The orchestrator only calls `filter_page`.

**The pattern: the server is always the source of truth.** The resident engine is
a read-side accelerator for filtering only; any mutation frees + reloads it.

## 4 — Interaction modes (wired to `/steps`)

One mode at a time: `mode ∈ {browse, select, edit, delete}`. The toolbar toggles
report a click; `setMode(next)` toggles off if re-clicked and calls
`grid.setInteraction(mode)`. Edit/delete commit through the **same `/steps`
endpoint the clean ops use** (position-based, over the loaded window):

| Mode | Handler | Step | Params |
|---|---|---|---|
| edit | `commitEdit(rowKey,colKey,value)` | `set_cell` | `{ row: Number(rowKey), column: colKey, value }` |
| delete | `commitDelete(rowKey)` | `drop_rows` | `{ indices: [Number(rowKey)] }` |

Both go through `applyStep` → `POST /files/:rid/steps` → toast with an **Undo**
action (→ `POST /files/:rid/undo`) → `afterMutation()`.

### ⚠ The correctness gate — no edit/delete under a filter

`set_cell`/`drop_rows` address rows by **absolute dataframe index**, but a
**filtered page is keyed by filter-relative position** (`data::view::page` windows
the filtered frame with no index column). So editing/deleting under a filter would
mutate the *wrong* row. This is a **correctness guard, not a permission gate**.
Enforced at three points:

- `setMode` refuses to enter edit/delete while filtered (toast: *"Clear the filter to edit or delete rows — positions shift under a filter."*).
- `applyFilter` drops back to `browse` if a filter is applied while in edit/delete.
- `commitEdit`/`commitDelete` early-return on `isFiltered()` as a backstop.

The real fix (DC3+) is stable per-row IDs so mutations survive filtering. Keep
this gate until then.

---

## 5 — The catalogs (the discoverability artifacts)

### `clean-catalog.js` — every clean op as data

`CLEAN_OPS` is the whole cleaning palette, declarative. Each entry's **`id` is the
exact step `kind`** the backend dispatches, and each field `key` is the param that
step reads. Entry shape:

```js
{ id, label, icon,
  scope,            // "global" (no selection) | "column" (acts on selected columns)
  min?, max?,       // selection-count gate for scope:"column" (default min 1)
  fields?,          // [{ key, type:"text"|"number"|"enum"|"bool"|"sentinels", label, options?, default?, placeholder? }]
  build(sel, vals)  // (selectedColumnNames, fieldValues) → params object
}
```

15 ops: global — `snake_case_columns`, `replace_in_names`, `change_case`,
`unwrap_csv`; column-scoped — `drop_columns`, `filter_columns`, `drop_nulls`,
`fill_nulls`, `replace_text`, `cast`, `rename_column`, `split_column`,
`join_columns`, `format_dates`, `fix_invalid`. Helpers: `cleanOp(id)`,
`opEnabled(op, selectionCount)`.

> **Not yet wired.** The Clean tab today renders a hardcoded first-cut list
> (`CLEAN_STEPS`, 5 no-field one-click ops) via `mountCleanList`, not `CLEAN_OPS`.
> The full catalog is the spec the **DC3b** column-manager + action-sheet will
> consume (rendering each op's `fields` via `field.js`).

### 🚧 GOTCHAS before wiring `clean-catalog.js` (DC3b)

The catalog was written ahead of its consumer and has **value-name divergences
from the backend step vocabulary** — wiring it verbatim would ship ops that `400`
at `/steps`. Fix the catalog values, or map them in the column-manager, before
wiring:

- **`cast`** — catalog sends `dtype: "string" | "i64" | "f64" | "bool" | "date"`, but the backend (`cells.rs`) accepts only `"int" | "float" | "str" | "bool" | "date" | "datetime" | "time"`. So `string → str`, `i64 → int`, `f64 → float`; `string`/`i64`/`f64` as-is hit the `unsupported dtype` arm.
- **`fill_nulls`** — catalog offers `strategy: "fixed" | "forward" | "backward" | "mean"`, but the backend handles only `"fixed" | "zero" | "forward"`. `backward` and `mean` hit `unknown fill strategy`.
- **`format_dates`** — backend also supports `on_incomplete: "drop"` (filters unparseable rows); the catalog only exposes `null`/`keep`.
- Backend hard limits the column-manager UI must respect: `split_column` caps at **MAX_PARTS = 10** new columns; `join_columns` requires **exactly 2** columns (matches the catalog's `min:2/max:2`).
- `cast` does locale-aware FR number/bool coercion **only when the source column is `String`**; re-casting an already-numeric column takes the plain Polars path (so FR-number recovery "won't fire" on a re-cast).

### `toolbar-spec.js` — toolbar as pure `state → controls`

`mainToolbar(state)` returns the grid-toolbar control list — reading the function
*is* reading the toolbar. Controls: `upload`, `filter` | `edit`/`select`/`delete`
toggles (`group:"mode"`, active when `s.mode===id`) | `undo`/`redo` (gated by
`when: s.canUndo/canRedo`)/`refresh` | `rows` menu (`PAGE_SIZES =
[100,500,1000,5000]`) / `cols` menu (per-column show/hide) / `clearsel` chip
(visible when `selectionCount>0`) | `export` menu (CSV/Excel/JSON) / `tools`. Gates
are functions of state, re-evaluated by grid-toolbar on `update`.

Dispatch: `onToolbarAction(id, ctx)` — `ctx.menu==="export"` →
`location.href=/api/files/:rid/export?format=<id>`; `"rows"` → set pref +
`renderView()`; `"cols"` → toggle `hiddenCols` + repaint; bare ids → open panels /
`setMode` / undo / redo / refresh / clearsel.

### `report-spec.js` — the report vocabulary

`AGG_FNS` = the 8 aggregations exposed (`count`, `count_distinct`, `sum`, `mean`,
`min`, `max`, `first`, `last`); each `value` is a `shared::report::AggFn` (the
backend also supports `median`/`q1`/`q3`, not exposed in the builder).
`buildReportSpec({groupBy, measures, filter})` → the server `ReportSpec`: drops
incomplete measures, maps each to `{col, fn, alias:"<Label> of <col>"}`, sets
`group_by` (empty → single summary row), attaches `filter` when present.

---

## 6 — The Report flow (DC3a)

`mountReportBuilder(host, { columns, aggFns, onRun, onClear })` is a
product-agnostic form (removable group-by chips + fn × column measure rows). On
Run it emits `{ groupBy: [colKey], measures: [{col, fn}] }`.

The orchestrator mounts it in the LEFT Report tab and handles `runReport`:
1. `buildReportSpec({groupBy, measures, filter: filterNode})` (the active filter scopes the report).
2. `await api.post("/group/preview", { file_id: current.rid, spec })` → `POST /api/group/preview`.
3. The response is the **page shape** `{ columns, rows, total }` — `rows` are stringified arrays aligned to `columns` (the same `data::view::page` shape as `/files/:rid/page`). Fill the bare report grid-view with it.
4. `showReport()` swaps the center to the report pane, closes the left drawer on narrow, sets the surface to `<filename> · report` with a group-count meta.

"Back to data" (`showData()`) restores the data pane + `dataMeta`. The placement
is a deliberate better-than-prerelease call: a derived table belongs in the **wide
center**, not the narrow side panel.

> A type-invalid aggregation (e.g. `sum` on a text column) returns a `400` from
> the engine; the orchestrator surfaces it as a danger toast. The builder doesn't
> yet filter aggregations by column dtype — a DC3 polish.

---

## Endpoints this page touches

| Action | Method + path |
|---|---|
| File summary / score | `GET /api/files/:rid` |
| Page (no filter) | `GET /api/files/:rid/page?offset=&limit=` |
| Page (filtered, server fallback) | `POST /api/files/:rid/page` `{offset, limit, filter}` |
| Apply clean/edit/delete step | `POST /api/files/:rid/steps` `{kind, params}` |
| Undo / Redo | `POST /api/files/:rid/undo` · `/redo` |
| Steps / history | `GET /api/files/:rid/steps` |
| Joins detect / execute | `GET` · `POST /api/files/:rid/joins` |
| Report preview | `POST /api/group/preview` `{file_id, spec}` |
| Upload | `POST /api/files` (multipart) |
| Export / resident-engine load | `GET /api/files/:rid/export?format=csv\|xlsx\|json` |
| Recents | `GET /api/files?limit=` |

Full request/response shapes + the engine behind them: [`backend.md`](backend.md).
