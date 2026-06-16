# The Data Cleaner (`apps/studio/workspace`)

The Data Cleaner is the `workspace` page of the `studio` app (route `#/workspace`,
visible label "Data Cleaner"). Its entry file is a **thin orchestrator** over the
composable framework primitives (see [`components.md`](components.md)): it owns
the data lifecycle, the `/steps` source-of-truth contract, the staged-clean
preview buffer, and the interaction modes — the look lives entirely in framework
components. The toolbar, the clean ops, and the report vocabulary are expressed
as **data** in three sibling spec files.

The post-DC3b page is **one full-bleed surface**: a slim toolbar over a
full-surface table. Every secondary tool — filter, clean, SQL, joins, report,
history — is **summoned in a modal** off a toolbar button; there are no pinned
side panels. The earlier 3-panel `workspace-panels` shell is gone.

## Current build state

| Phase | Status | What |
|---|---|---|
| **DC1** | ✅ done (`9ddb028`) | App-wide responsive foundation: breakpoint tokens, the rail off-canvas drawer (scrim + matchMedia), responsive chrome down to 1024×768 |
| **DC2** | ✅ done (`6243501`) | The composable grid (`grid-toolbar`/`grid-view`), redtable edit/select/delete modes, the `clean-catalog`/`toolbar-spec` data files |
| **DC3a** | ✅ done (`2765f4f`) | The **Report flow** — `report-builder` + `report-spec`, `POST /api/group/preview`, summoned in a modal |
| **DC3b** | ✅ done | The full-surface refactor + the **column-manager** consuming the whole `clean-catalog.js` (cast/fill/replace/split/rename per selected column), staged-preview cleaning, the client-first SQL console |
| **DC3c** | ✅ done | **Nested AND/OR filter groups** via `mountFilterPanel` (the `FilterNode` tree + `apply_filter` are recursive — frontend over the existing endpoint) |

> **DC3 needs no new wasm wrappers.** `POST /api/group/preview` (reports), `POST
> /api/files/:rid/steps[/batch]` (clean/edit/delete), and the recursive
> `FilterNode` on `POST /page` already cover the feature set. See
> [`../backend/api-routes.md`](../backend/api-routes.md).

## The layout — one full-bleed surface

```
┌ topbar: ☰  RedPash   [ omnisearch ]   apps  user ──────────────────────────┐
├ rail ┬ grid-toolbar ──────────────────────────────────────────────────────┤
│ (gl. │ [save][discard] upload ⛛ |search| ✎☑🗑 ↶↷ ⟳ # rows cols ⬇ sql ⋈ … │
│ nav) ├ redtable ──────────────────────────────────────────────────────────┤
│      │                                                                      │
│      │   data grid (the whole surface — head:false, layout:"fill")         │
│      │                                                                      │
└──────┴──────────────────────────────────────────────────────────────────────┘
       summoned in a modal (one at a time): filter · clean · sql · joins ·
                                            report · history
```

`renderLoaded()` assembles the page with `head:false` (no title band) and a single
`{ key:"work", layout:"fill" }` section, then mounts one `grid-view` (toolbar +
table) into it that takes the whole surface. No `workspace-panels`, no
`side-panel`, no stacked center panes. Secondary tools open through `openModal`
(`framework/modal/modal.js`) and close on apply, so each re-summon re-reads the
current columns/state.

## Files

| File | Role |
|---|---|
| `workspace.js` | Orchestrator: `mount`, render branches, data lifecycle, staged-clean buffer, modes, dispatch, modal summoning |
| `clean-catalog.js` | The clean-op palette as data — **wired** into the Clean modal via `mountColumnManager` |
| `toolbar-spec.js` | The main toolbar as `state → controls` |
| `report-spec.js` | `AGG_FNS` vocabulary + `buildReportSpec` |
| `workspace.css` | Page-scoped only (`.pg-studio-workspace-*`); never touches a framework `.rp-` class |
| `framework/column-manager/` | The per-column clean surface (multi-select + op palette + inline action-sheet); owns `.rp-colmgr-*` |
| `framework/sql-editor/` | The read-only SQL console (textarea + Run + Save-as-file); owns `.rp-sqleditor-*` |
| `framework/report-builder/` | Product-agnostic group-by + measures form (owns `.rp-rb*`) |
| `framework/engine/window-source.js` | The pluggable window seam: `serverSource`/`clientSource` behind one `window(spec,offset,limit)` interface, routed by `pickSource` |

---

## 1 — Orchestrator structure (`workspace.js`)

```js
export default async function mount(root, ctx) { … return { destroy: () => destroyPage() }; }
```

Reads the session via `ctx.getSession()`, parses an optional `?file=<rid>`
deep-link off `location.hash`, and ends by opening the deep-linked file or
rendering empty. Two render branches, each preceded by `destroyPage()`:

- **`renderEmpty()`** — the Overview / upload landing. `assemblePage` with `sections:[{key:"main"},{key:"files", title:"Files"}]`; mounts the `uploader` into `main` and the Files table into `files` via `mountObjectList` (the generic redtable-over-`/files` object-list, not a bespoke recents grid — a row click → `openFile(r.rid)`).
- **`renderLoaded()`** — the loaded cleaner. `assemblePage` with `head:false` + `sections:[{key:"work", layout:"fill"}]`, then `gridView = mountGridView(page.section("work"), { toolbar, table })` — one full-bleed grid-view. `grid = gridView.table`. No panels; tools summon as modals (§3).

**Rail integration** (`railSpec`): an `overview` pseudo-tab (`bi-magic`, active
when no file is open) whose `onSelect` calls `renderEmpty()`; an `onRailTab` that
opens file tabs in place; reports the active `rid`.

## 2 — Data lifecycle

All persistent state is on the server; the orchestrator mutates through endpoints
and re-reads. (`api.*` prefixes `/api`; the `export` download spells out
`/api/...` on `location.href`.)

- **`openFile(rid)`** — `GET /files/:rid` summary (+ `fileName(rid)` from `/files?limit=50`) → reset view state (`filterNode=null`, `sort=null`, `query=""`, `mode="browse"`, clear selection + hidden cols, `sqlSource?.destroy()`) → `renderLoaded()` → parallel `renderView()` + `refreshSteps()`.
- **`uploadFile(file)`** — `api.upload("/files", fd)` → toast → `invalidateRailData()` → `openFile(out.rid)`.
- **`renderView()`** — paints the grid from the server. Always `POST /files/:rid/page { offset:0, limit:pageRows(), sort:[…], filter? }` (offset is fixed at 0 — the page is the loaded window, search is client-side over it). Updates `columns`/`allRows` (via `mapRows`, which keys each row by its window index as `__k`), prunes stale hidden cols, then `paintGrid()` + `refreshToolbar()`. Page size from the `workspace.page_rows` pref (default **1000**; `PAGE_SIZES = [100,500,1000,5000]`).
- **`paintGrid()`** — `grid.update({ columns: visibleColumns(), rows: filteredRows(), sort })`. `filteredRows()` applies the **client-side search** (`query`) over `allRows`; `visibleColumns()` drops `hiddenCols`.
- **`afterMutation()`** — after every committed frame-changing op: `await Promise.all([renderView(), refreshSteps()])`. There is no resident-engine free/reload step in this loop — the server-page render is the single repaint path.

## 3 — The window seam + summoned tools

### The window-source seam (`framework/engine/window-source.js`)

One interface, two sources, the **same `QuerySpec`**:

```js
{ kind, ready, window(spec, offset, limit) → page, sql(query) → page, score() → report|null, destroy() }
//  page = { columns, rows, total } ;  spec = { filter?, search?, sort? } | null
```

- **`serverSource(rid)`** — `POST /page` / `POST /sql`. Stateless: re-reads the `.bin` + runs the pipeline per call. The source of truth and the fallback for frames past the client memory budget.
- **`clientSource(rid)`** — a resident wasm `Workbook` in a Worker (`engine-worker.js`), parsed **once** on open, then answering warm `window`/`sql` off-main-thread; a separate killable **peak-op** engine runs `score()` so its high-water never sticks to the resident floor. The data never leaves the device.
- **`pickSource(rid, { rows, cols })`** — routes by a `rows × cols` budget (`CELL_BUDGET = 12_000_000`): `clientSource` where it fits, `serverSource` for the genuinely huge tail.

**What actually goes through the seam today: the SQL console only.** `renderView()`
calls `POST /page` directly (it does **not** call `source.window(...)`). The seam
is wired into the SQL path: `ensureSqlSource()` lazily calls `pickSource(current.rid,
{ rows: current.row_count, cols: columns.length })` per open file; `runSqlPage(q)`
calls `sqlSource.sql(q)` (client-first), falling back to `POST /files/:rid/sql` if
the worker throws. `sqlSource` is reset on `openFile` and freed in `destroyPage`.
The `window()`/`score()` halves of the seam exist but aren't yet UI-wired here.

### Summoned tools (modals)

Each toolbar button opens an `openModal` body and mounts one framework component;
most close on apply so the next summon re-reads `columns`:

| Button | Handler | Mounts | Effect |
|---|---|---|---|
| filter | `openFilter` | `mountFilterPanel` | `onApply(node)` → `applyFilter` → `renderView()` |
| clean | `openClean` | `mountColumnManager` | `onApply(op,cols,values)` → `runCleanOp` (stages, §5) |
| sql | `openSql` | `mountSqlEditor` + result `redtable` | Run → `runSqlPage`; Save → `POST /sql/materialize` |
| joins | `openJoins` | `mountJoinsWizard` | execute → `POST /joins` → `openFile(out.rid)` |
| report | `openReport` | `mountReportBuilder` + result `redtable` | Run → `POST /group/preview` (§6) |
| history | `openHistory` | `mountStepsPanel` | Undo/Redo → `POST /undo` · `/redo` |

## 4 — Interaction modes (wired to `/steps`)

One mode at a time: `mode ∈ {browse, select, edit, delete}`. The toolbar toggles
are a click; `setMode(next)` toggles off if re-clicked and calls
`grid.setInteraction(mode)`. Edit/delete commit through the **same `/steps`
vocabulary the clean ops use** (position-based, over the loaded window):

| Mode | Handler | Step | Params |
|---|---|---|---|
| edit | `commitEdit(rowKey,colKey,value)` | `set_cell` | `{ row: Number(rowKey), column: colKey, value }` |
| delete | `commitDelete(rowKey)` | `drop_rows` | `{ indices: [Number(rowKey)] }` |

Both go through `applyStep` → `applySteps([…], label)` → `POST /files/:rid/steps/batch`
→ toast with an **Undo** action (pops N `POST /undo`) → `afterMutation()`. Unlike the
staged clean ops, edit/delete commit **immediately** (v1).

### ⚠ The correctness gate — no edit/delete under a filter

`set_cell`/`drop_rows` address rows by **absolute dataframe index**. The page is
fetched at `offset:0`, so a row's `__k` IS its absolute index — **until** a server
filter makes the page filter-relative, at which point position-based mutation
would hit the *wrong* row. This is a **correctness guard, not a permission gate**.
Enforced at two points:

- `setMode` refuses to enter edit/delete while `filterNode` is set (toast: *"Clear the filter to edit or delete rows — positions shift under a filter."*).
- `applyFilter` drops back to `browse` if a filter is applied while in edit/delete (toast: *"Edit/Delete paused while a filter is active."*); `commitEdit`/`commitDelete` early-return on `filterNode` as a backstop.

The real fix is stable per-row IDs so mutations survive filtering. Keep this gate
until then.

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

> **Wired (DC3b).** The Clean modal mounts `mountColumnManager(host, { columns,
> ops: CLEAN_OPS, onApply })` — a column multi-select + the op palette (global vs
> column-scoped), with an inline action-sheet that renders each op's `fields` via
> `field.js`. On Apply the page's `runCleanOp(op, cols, values)` calls `op.build`
> and **stages** the resulting step(s) (§5.1). The component reads only the generic
> `id/label/icon/scope/min/max/fields` and emits `onApply` — `op.build` stays on
> the page, so the framework never imports a page module.

The catalog's `dtype`/`strategy`/`on_incomplete` values now match the backend step
vocabulary verbatim (`cast` → `str|int|float|bool|date`; `fill_nulls` →
`fixed|forward|zero`; `format_dates` → `null|drop|keep`), so an op fires straight
through `/steps` with no per-op mapping. Backend hard limits the catalog already
respects: `join_columns` requires **exactly 2** columns (`min:2/max:2`);
`split_column` is `min:1/max:1`. (Backend note: `cast`'s locale-aware FR number/bool
coercion fires **only when the source column is `String`** — a re-cast of an
already-numeric column takes the plain Polars path.)

### `toolbar-spec.js` — toolbar as pure `state → controls`

`mainToolbar(state)` returns the grid-toolbar control list — reading the function
*is* reading the toolbar. In Em's spec order:

- `save` / `discard` buttons — present only while `s.dirty` (staged steps pending, §5.1).
- `upload` button; `filter` toggle (active when `s.hasFilter`).
- `search` input (`kind:"search"`, value `s.query`) — the client-side search box.
- `edit` / `select` / `delete` toggles (`group:"mode"`, active when `s.mode===id`).
- `undo` / `redo` buttons (gated by `when: s.canUndo / s.canRedo`); `refresh` button.
- `rownum` toggle (leading #-column, active when `s.rowNumbers`).
- `rows` menu (`PAGE_SIZES = [100,500,1000,5000]`, checkmark on `s.pageRows`) · `cols` menu (per-column show/hide checkmarks) · `clearsel` chip (visible when `s.selectionCount>0`).
- `export` menu (CSV/Excel/JSON).
- `sql` · `joins` · `report` · `history` · `clean` buttons — each summons its modal.

Gates (`when`/`active`/`visible`/`label`) are functions of state, re-evaluated by
grid-toolbar on `update`; `refreshToolbar()` re-runs `mainToolbar(toolbarState())`.

Dispatch: `onToolbarAction(id, ctx)` — `id==="search"` → set `query` + `paintGrid()`
(client-side); `id==="filter"` → `openFilter()`; `ctx.menu==="export"` →
`location.href = /api/files/:rid/export?format=<id>`; `"rows"` → set pref +
`renderView()`; `"cols"` → toggle `hiddenCols` + repaint; bare ids → `save`/`discard`
/ `refresh` / `history`/`clean`/`sql`/`joins`/`report` summons / `rownum` toggle /
`setMode` / undo / redo / clearsel.

### 5.1 — Staged cleaning (preview → Save)

A clean op **stages** rather than commits. `runCleanOp(op, cols, values)` builds
the step(s) and calls `stageSteps`:

- A single-column param (`"column" in params`) over a multi-selection fans out to **one step per column** (`op.build([c], values)` each); array-shaped ops (e.g. `join_columns`, `fix_invalid`) stay a single step.
- `stageSteps` pushes them onto `pendingSteps` and calls `previewPending()`, which `POST /files/:rid/steps/preview { offset:0, limit:pageRows(), steps }` — the **same engine Save runs**, so the preview is exact. The grid repaints from the previewed (committed + pending) frame.
- The toolbar's `dirty` state goes true (`pendingSteps.length > 0`), surfacing `save` / `discard`.
- **Save** (`saveStaged`) clears the buffer first, then commits the whole chain via `applySteps` → `POST /files/:rid/steps/batch` (one atomic gesture, one Undo); **Discard** (`discardStaged`) drops the buffer and `renderView()`s the committed frame.

The `/steps/batch` endpoint **pre-flights the whole chain**, so a mid-chain failure
rejects the entire Save (vs N `/steps` calls that could leave a partial commit). The
Undo toast pops exactly as many steps as were committed.

### `report-spec.js` — the report vocabulary

`AGG_FNS` = the 8 aggregations exposed (`count`, `count_distinct`, `sum`, `mean`,
`min`, `max`, `first`, `last`); each `value` is a `shared::report::AggFn` (the
backend also supports `median`/`q1`/`q3`, not exposed in the builder).
`buildReportSpec({groupBy, measures, filter})` → the server `ReportSpec`: drops
incomplete measures, maps each to `{col, fn, alias:"<Label> of <col>"}`, sets
`group_by` (empty → single summary row), attaches `filter` when present.

---

## 6 — The Report flow (DC3a)

`mountReportBuilder(host, { columns, aggFns, onRun })` is a product-agnostic form
(removable group-by chips + fn × column measure rows). On Run it emits
`{ groupBy: [colKey], measures: [{col, fn}] }`.

`openReport()` summons a modal with the builder over a result `redtable` and
handles each Run:
1. `buildReportSpec({groupBy, measures, filter: filterNode})` (the active filter scopes the report).
2. `await api.post("/group/preview", { file_id: current.rid, spec })` → `POST /api/group/preview`.
3. The response is the **page shape** `{ columns, rows, total }` — `rows` are stringified arrays aligned to `columns` (the same `data::view::page` shape as `/files/:rid/page`). The result `redtable` is mounted on the first Run (paged, `pageSize:100`) and `.update`d on each subsequent Run.

The report renders **in the modal**, not by swapping the main grid — the cleaner
surface stays put underneath. (The earlier "swap the wide center" placement went
away with the panel shell; the modal is now the home for every derived view.)

> A type-invalid aggregation (e.g. `sum` on a text column) returns a `400` from
> the engine; `openReport` catches it and surfaces a danger toast. The builder
> doesn't yet filter aggregations by column dtype — a later polish.

---

## Endpoints this page touches

| Action | Method + path |
|---|---|
| File summary | `GET /api/files/:rid` |
| Page (window) | `POST /api/files/:rid/page` `{offset, limit, sort, filter?}` |
| Stage preview | `POST /api/files/:rid/steps/preview` `{offset, limit, steps}` |
| Commit clean/edit/delete | `POST /api/files/:rid/steps/batch` `{steps:[{kind, params}]}` |
| Undo / Redo | `POST /api/files/:rid/undo` · `/redo` |
| Steps / history | `GET /api/files/:rid/steps` |
| SQL run / materialize | `POST /api/files/:rid/sql` `{sql}` · `/sql/materialize` `{sql, materialize_as}` |
| Joins detect / execute | `GET` · `POST /api/files/:rid/joins` |
| Report preview | `POST /api/group/preview` `{file_id, spec}` |
| Upload | `POST /api/files` (multipart) |
| Export / client-source load | `GET /api/files/:rid/export?format=csv\|xlsx\|json` |
| Files list (Overview + `fileName`) | `GET /api/files?limit=` |

> `renderView` always uses **`POST /page`** (the window query carries `sort`/
> `filter`); there is no `GET /page` path in this orchestrator. Single-step commits
> go through `/steps/batch` too (`applyStep` wraps a one-element batch) — the page
> never calls a bare `/steps`. The `clientSource` (window-source) re-parses from the
> CSV `export` endpoint.

Full request/response shapes + the engine behind them: [`../backend/api-routes.md`](../backend/api-routes.md) + [`../backend/data-engine.md`](../backend/data-engine.md).
