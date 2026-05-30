---
title: Home page (`#/home`)
section: Frontend
order: 11
last modified date: 2026-05-25
---

# Home page (`#/home`)

The authenticated landing surface — **the org command center**. Topbar
over a rail-page shell: a `.rt-nav` rail on the left, an `.rt-surface`
body on the right whose content swaps per tab. Every tab is a
schema-driven list page: section head → optional chip row → KPI /
charts strip → toolbar → paged redtable.

The previous "pipeline board" landing (four-column stage board over
greeting + uploader) was retired 2026-05-25; uploads moved off Home
into the Workspace flow, and the rail's `Projects` tab covers the
"what's in flight" surface a board used to.

---

## Files

| File | Role |
|---|---|
| [`partials/home.html`](../../../../frontend/partials/home.html) | Markup. Topbar + `.rp-shell.rp-shell--wide` outer flex; `.rt-nav#rpHomeNav` rail + `.rt-surface#rpHomeView` body. Body is one container — `home.js` rewrites its innerHTML on every tab switch. |
| [`styles/pages/home.css`](../../../../frontend/styles/pages/home.css) | Home-specific tweaks. The bulk of the layout lives in the shared atoms ([`shell.css`](../../../../frontend/styles/shell.css), [`nav.css`](../../../../frontend/styles/nav.css), [`table.css`](../../../../frontend/styles/table.css), [`pager.css`](../../../../frontend/styles/pager.css), [`toolbar.css`](../../../../frontend/styles/toolbar.css), [`card.css`](../../../../frontend/styles/card.css)). |
| [`scripts/pages/home.js`](../../../../frontend/scripts/pages/home.js) | `HOME_TABS` + `HOME_GROUPS` (rail content) and `LIST_VIEWS` (per-tab spec). Mount → render rail → activate default tab → `fetchList(spec, chipState)` paints the body. |
| [`scripts/list-page.js`](../../../../frontend/scripts/list-page.js) | Shared HTML builders (`headHTML`, `kpiStripHTML`, `chartsStripHTML`, `compositeStripHTML`, `chipRowHTML`, `listToolbarHTML`, `listPanel`) + pager + chart lifecycle. Monitoring uses the same module. |

---

## The rail — `HOME_TABS` × `HOME_GROUPS`

`HOME_TABS` is the declarative tab definition (rail order = source
order). Each entry carries `group` (one of `ORG` / `DATA` / `MANAGE`),
`key`, `label`, `icon` (Bootstrap-Icons class), `perm` (informational
until RBAC lands), `endpoint` (un-prefixed; display-only), and `wired`
(`false` renders the tab as a disabled stub — same discipline as the
parity inventory).

The current tabs (2026-05-25):

| Group | Tab | Endpoint | Notes |
|---|---|---|---|
| ORG    | Users       | `/admin/users`       | composite-strip; KPI tiles flanked by 2 charts |
| ORG    | Companies   | `/admin/companies`   | composite-strip |
| ORG    | Memberships | `/admin/memberships` | composite-strip |
| ORG    | Cases       | `/cases`             | composite-strip; row click → `#/cases?id=…` |
| DATA   | Projects    | `/projects`          | kpi + charts; default tab |
| DATA   | Files       | `/admin/files`       | composite-strip; chip-row filters by `?stage=` |
| DATA   | Charts      | `/admin/charts`      | composite-strip; row click → Workspace+chart |
| MANAGE | Org         | `/admin/org`         | `wired: false` — stub until the unified endpoint lands |

`HOME_GROUPS` declares the section headers + 2-letter rail marks
(`OR` / `DA` / `MG`) and the per-group accent color. Activating a tab
writes its key to `localStorage.rp-home-active-tab` so a reload lands
back on the same surface.

---

## LIST_VIEWS — per-tab spec

Each tab is one entry in the `LIST_VIEWS` object. A spec describes
**what** the tab renders (title, endpoint, columns, row HTML, charts,
chip-rows, toolbar slots, modes) — the **how** lives in
`fetchList(spec, chipState)` and the shared list-page module.

```js
{
  title:           "Users",
  endpoint:        "/admin/users",
  patchEndpoint:   "/users",                // PATCH target (display_name, …)
  deleteEndpoint:  "/users",                // optional override for DELETE
  itemNoun:        "user",
  itemNounPlural:  "users",
  modes:           { select: true, delete: true },
  statsEndpoint:   "/admin/users/stats",    // KPI + charts feed
  compositeStrip:  true,                    // [chart][chart][2×2 stats][chart][chart]
  chipRows:        [{ name, label, options, default }],
  charts:          [ { id, title, kind, data, opts? } ],
  toolbar:         { searchPlaceholder, modes, refresh, undoRedo?, history?, columns?, export? },
  columns:         [ { label, key, sortable, editable?, editKey?, defaultHidden? } ],
  row:             (record) => "<tr …>…</tr>",
}
```

`compositeStrip: true` replaces the default stacked KPI-then-charts
shape with the 5-cell composite (see [Charts](#charts) below). Tabs
without it fall back to a `.rp-kpi-strip` over a `.rp-home-charts` row.

---

## Section composition (top → bottom)

The body view is a strict 6-section stack — locked 2026-05-25; a new
tab joins by adding a `LIST_VIEWS` entry, never by changing the
template.

1. **Head** — `headHTML(title, count)` — title + count chip.
2. **Chip row(s)** — `chipRowHTML(spec.chipRows)` — discrete filters
   (Files' `?stage=`, Charts' `?window=`, Memberships' scope, etc.).
3. **KPI / charts strip** — either `compositeStripHTML(tiles, charts)`
   (5-cell) **or** `kpiStripHTML(tiles)` over `chartsStripHTML(charts)`
   (stacked).
4. **Toolbar** — `listToolbarHTML(spec.toolbar)` — search · sort
   indicator · refresh · mode toggles (edit/select/delete) ·
   undo/redo · history · columns · export. Per-page hiding follows the
   [[display-none-per-page]] principle: one shared template with all
   buttons, the tab-specific spec omits via boolean flags, the omitted
   buttons are hidden in CSS by id (`#rp-list-toolbar-history` etc.).
5. **Panel** — `listPanel(columns)` over the redtable: `.rt-card` >
   `.rt-table-wrap` > `.rt-table` with the column headers + an empty
   tbody. `fetchList` paints the `<tr>` rows via `spec.row(record)`.
6. **Pager** — `renderListPager(...)` — elide-at-7-pages logic shared
   with Monitoring.

The panel flex-fills the remaining surface height so the pager pins to
the bottom of the viewport (per `.rt-surface` + foundation flex rules
in [`table.css`](../../../../frontend/styles/table.css) and
[`pager.css`](../../../../frontend/styles/pager.css)).

---

## Columns — sortable, hideable, reorderable

Every column declares its `sortable` flag in the spec. The shared
`listPanel` builder emits `<th>` with:

- `data-col-key="<key>"` (stable key for state)
- `class="rp-list-sortable"` if `sortable: true` — click toggles sort
  asc / desc and re-fires `fetchList` with `?sort=&dir=`
- `draggable="true"` on **every** TH — pick up a header and drop it on
  another to reorder columns

### Sort

`sortable: true` on a column promises the wire-key is in the
backend's `SORTABLE_*` allowlist (`admin.rs::SORTABLE_USERS`,
`SORTABLE_COMPANIES`, `SORTABLE_MEMBERSHIPS`, `SORTABLE_FILES`,
`SORTABLE_CHARTS`; `cases.rs::SORTABLE_CASES`). The lists are checked
in the route's match arm — unknown keys fall back silently to
`created_at desc`, never panic, so frontend bugs degrade to a
default-sort, not a 500.

Sortables-by-tab expanded 2026-05-25 (`41cc87c`): Users now sort by
username / email / organisation; Memberships by user_username / scope;
Cases by reporter / project_id / company_id / category_name /
created_at; Files by col_count / file_size_bytes / cleanness_pct /
created_at; Charts by filename / created_at. Columns left
`sortable: false` are either derived (per-caller `my_role`),
join-driven names not yet in the allowlist (Files' `project`), or
free-text fields (`description`, `error_message`).

### Hide / show

A `defaultHidden: true` column starts hidden; the toolbar's **Columns**
dropdown lets the user toggle each on/off. The choice persists per-tab
in `localStorage.rp-cols-hidden-${tab.key}` and is replayed by
`view._applyHiddenColumns()` after every `fetchList` paint (so the
state survives a refresh, a sort, a chip-row change, and a row edit).

### Reorder — click and grab (`eb4cfc7` + `8fe39f4`)

Every TH carries `draggable="true"`. Drag a header onto another TH to
reorder:

- `dragstart` on the source — adds `.is-dragging` (CSS fades the cell
  to opacity 0.45) and stashes the source key in `dataTransfer`.
- `dragover` on a target TH — computes which **half** of the TH the
  cursor is over (`e.offsetX < midpoint`) and adds
  `.is-drop-before` (accent left-edge box-shadow) or `.is-drop-after`
  (accent right-edge). The indicator promises the drop site; the drop
  handler computes the new index from the same midpoint check so what
  the indicator promises is what lands.
- `drop` — splices the source out of the order, computes
  `adjTgt = tgtIdx > srcIdx ? tgtIdx - 1 : tgtIdx`, then inserts at
  `before ? adjTgt : adjTgt + 1`, persists to
  `localStorage.rp-cols-order-${tab.key}`, and calls
  `view._applyColumnOrder()` to physically reorder THs **and** every
  body cell.

The reorder body-cell pass skips the leading `.rp-list-sel` checkbox
cell (its position is fixed by mode) — only data columns move.

### Edit

`editable: true` on a column makes the cell `contenteditable` while
the panel carries `.rt-card-mode-edit`. Edits commit on blur / Enter
via `PATCH ${spec.patchEndpoint}/:rid { [editKey]: value }`. Edits
are also threaded into the session history dropdown
(`#rp-list-toolbar-history`) — see commit `4475fa7`.

---

## Charts — composite strip and twins

A tab can declare 1–4 charts. With `compositeStrip: true`,
`compositeStripHTML` lays them out in a 5-cell row:

```
[chart 20%] [chart 20%] [stats 2×2 20%] [chart 20%] [chart 20%]
```

Each chart spec is `{ id, title, kind, data, opts? }` where `kind` is
one of `donut` / `bar` / `barH` / `gauge` / `rose` / `pie` / `line`
(ECharts wrappers in [`echarts-kpi.js`](../../../../frontend/scripts/echarts-kpi.js)).
`data` is a function over the stats payload that returns the kind's
expected shape (a record map for categorical kinds, a scalar for
`gauge`).

**Twin padding** (`f9c30d2`) — for tabs that declare fewer than 4
charts, the missing slots are padded by reusing the real chart data
with a different kind via `TWIN_KIND_SWAP` (`donut → bar`,
`bar → donut`, `rose → donut`, `pie → bar`, `line → bar`,
`gauge → gauge`). The pattern stays visually anchored regardless of
how many charts a tab declares; no placeholder data leaks into the UI.

The chart lifecycle (mount / dispose / resize) is owned by
`createListCharts(view, { logPrefix: "home" })`. The same factory
backs Monitoring with `logPrefix: "mon"`.

---

## Toolbar slots

`listToolbarHTML(spec.toolbar)` always emits the same DOM landmarks;
spec flags toggle each slot:

| Slot | Spec flag | What it does |
|---|---|---|
| Search input    | `searchPlaceholder` (string)   | client-side filter over the loaded page + server `?q=` round-trip per debounce |
| Sort indicator  | implicit (visible if any col is sortable) | shows the active `?sort=&dir=` |
| Refresh         | `refresh: true`                | re-fires `fetchList` with current chip / sort / search |
| Modes           | `modes: { select?, delete?, edit? }` | toggles the panel mode class (`.rt-card-mode-{select,edit,delete}`) |
| Undo · Redo     | `undoRedo: true`               | session-local edit history; replays last PATCH |
| History         | `history: true`                | dropdown of recent searches + sorts (per-session) |
| Columns         | implicit                       | per-column show/hide menu — toggles `_applyHiddenColumns` state |
| Export          | `export: true`                 | CSV / JSON dump of the current visible page |

Hidden buttons follow [[display-none-per-page]]: ONE shared template,
hidden in CSS by id-scoped rules — never branch the template by spec.

---

## Backend wiring

| Surface | Endpoint | Status |
|---|---|---|
| Users tab        | `GET /api/admin/users` (+ `/stats`)        | ✅ live; sortable by username / email / organisation |
| Companies tab    | `GET /api/admin/companies` (+ `/stats`)    | ✅ live |
| Memberships tab  | `GET /api/admin/memberships` (+ `/stats`)  | ✅ live; sortable by user_username / scope |
| Cases tab        | `GET /api/cases`                           | ✅ live; sortable by reporter / project_id / company_id / category_name / created_at |
| Projects tab     | `GET /api/projects`                        | ✅ live; `Page<T>` conversion + sort allowlist pending |
| Files tab        | `GET /api/admin/files` (+ `/stats`)        | ✅ live; sortable by col_count / file_size_bytes / cleanness_pct |
| Charts tab       | `GET /api/admin/charts`                    | ✅ live; sortable by filename / created_at |
| Edit (PATCH)     | `PATCH /api/{users,companies,files}/:rid`  | ✅ live (one column per tab today; chip pickers for status/priority/role deferred) |
| Delete (bulk)    | `DELETE /api/{users,files,charts,…}/:rid`  | ✅ live |
| Export           | client-side CSV / JSON                     | ⛔ stubbed where flagged off; XLSX needs a backend round-trip |
| Org tab          | `/admin/org`                               | ⛔ stub — `wired: false` until the unified endpoint lands |

---

## Cache / refresh

The service worker is **install-only** and caches nothing, so a
partial / CSS / JS change shows up on a normal refresh — no
`CACHE_VERSION`, no double hard-refresh.
