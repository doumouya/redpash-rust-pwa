---
title: Objects page (`#/objects`)
section: Frontend
order: 12
---

# Objects page (`#/objects`)

The single browse surface for every object type — **Projects · Files ·
Reports · Dashboards · Companies · Users**. One redtable, a customizable
tab strip on top. Replaces the old Home steps 2–5 (four separate
scroll-snap redtables) and the standalone `/reports` + `/dashboards`
routes. Home keeps only its dashboard step; this is where you browse /
search / manage.

Full-bleed shell (`chrome: "full"` in the route table) — no
`rp-topbar`; the page owns its own header (`.rp-rt-topbar` +
`.rp-rt-page-title`: back-to-Home + title). Mirrors
`redpash-components/redpash-demo`'s `#page-objects`. The topbar class
was promoted from page-private `.obj-topbar` to the shared
`.rp-rt-topbar` rule in `main.css` so the Cleaner page can reuse the
same chrome.

---

## Files

| File | Role |
|---|---|
| [`partials/objects.html`](../../../../frontend/partials/objects.html) | Markup. `.rp-rt-topbar` header + `#obj-tabs` strip + one `.rp-rt-panel--embedded` redtable: header chrome, toolbar, predicate **filter side panel** + table, paging. |
| [`styles/pages/objects.css`](../../../../frontend/styles/pages/objects.css) | Library `@import`s + full-bleed `#page-objects` + tab strip (with drag-to-reorder cues) + customizable-tab styles + edit/select/delete icon-button mode CSS + the **glass control treatment**, glass-overlay rules for header/toolbar/tabs, **predicate filter panel** CSS, **row-number** column, **resizable-column** ellipsis rule, **column drag** cues (`.rp-rt-th-drag` / `.rp-rt-th-drop`), **sortable-header** affordances, **star toggle**, leading per-row open-button cell, and **cell-level anchors** (`.obj-cell-link` / `.obj-cell-id`) for the Projects-tab Name + Project-ID columns — all staged from the `redpash-demo/redtable` prototype. |
| [`scripts/pages/objects.js`](../../../../frontend/scripts/pages/objects.js) | The schema-driven redtable engine: `SCHEMAS`, `STATE`, `loadTable` / `renderTable`, tab switching, the predicate-filter engine, row-numbers + favorites toggles, **resizable columns** (`_objInitColResize`), **star toggle** (`_objStarBtn` / `objToggleStar`), **stage-driven row open buttons** (`_objRowOpenButtons`), bulk **score / clear-score**, and all the `obj*` inline-onclick globals. |
| [`scripts/objects-catalog.js`](../../../../frontend/scripts/objects-catalog.js) | Shared module — `OBJECT_TAB_CATALOG`, `OBJECT_TAB_KEYS`, `normalizeObjectTabs`. Imported by both `objects.js` and `profile.js` so the page and the Settings control agree on the catalog. |
| [`scripts/main.js`](../../../../frontend/scripts/main.js) (shell) | Route entry `{ path: "/objects", chrome: "full", … }`. `/reports` + `/dashboards` kept as `hidden: true` routes (builder hosts, no nav label). |

The page is the App's first surface caught up to the
`redpash-components/redpash-demo/redtable` factorization prototype —
glass controls, the predicate filter, row numbers, favorites and the
panel header chrome were all proven there first, then staged here
page-scoped (see the demo's superset-page notes).

---

## The tab strip

Tabs are rendered from `objTabs` — the user's chosen **subset** of the
catalog, not the full catalog. `_renderTabs()` paints one `.obj-tab`
per entry plus a trailing `+` add control.

- **Catalog** — `OBJECT_TAB_CATALOG` in `objects-catalog.js`: the six
  object types the app knows about (`projects`, `files`, `reports`,
  `dashboards`, `companies`, `users`), each with a label + Bootstrap
  icon. `companies` / `users` are read-only browse tabs — no creation
  flow on this page, so `objActivateTab` hides the toolbar **Add**
  affordance (`[data-rt-add]`) for them.
- **User's set** — `objTabs`, loaded in `mount()` from
  `ctx.session.prefs.objects_tabs` via `normalizeObjectTabs()` (drops
  unknown keys, falls back to the full catalog when nothing is saved).
- **Active tab** — `currentKind`. The `obj*` toolbar handlers are
  *kind-implicit*: they read `currentKind` rather than taking a `kind`
  argument, so the single shared toolbar markup doesn't bake the kind
  into every inline `onclick`.

### Customization — deletable tabs + add-back dropdown

Each tab carries a remove `×` (`.obj-tab-x`, hidden until tab-hover /
active). The trailing `+` (`.obj-tab-add`) opens a dropdown of the
object types **not** currently shown; disabled when every type is
already a tab.

| Handler | Behavior |
|---|---|
| `objRemoveTab(kind)` | Drops the tab. **Min-1** — the last remaining tab can't be removed (its `×` is omitted entirely). If the active tab is removed, the nearest neighbour becomes active. |
| `objAddTab(kind)` | Adds a hidden type back and switches to it. |
| `objToggleAddMenu(btn)` | Shows / hides the `+` dropdown. |

Both add and remove persist the new set to the account via
`rpSavePref("objects_tabs", [...objTabs])`. `objects_tabs` is **not**
in `main.js`'s `PREFS_LS_MAP` — it's an array, not a scalar — so
`rpSavePref` skips the localStorage stringify and only PATCHes
`/api/me` (+ updates the in-memory session). The same pref backs the
**Object tabs** control in `/profile`'s Settings section, so the page
and Settings stay in sync.

> Role-based permissions (e.g. Events / Cases tabs gated to support +
> Admin) are **not** wired yet — every catalog type is available to
> everyone for now.

### Deep links

`#/objects?tab=files` lands directly on that tab — Home's stat buttons,
bottom-left float bar, and minitable rows all link in this way. An
unknown / removed tab falls back to the user's first tab. `objActivateTab`
keeps the URL reload-stable via `history.replaceState`.

---

## Schema-driven redtable engine

All six kinds share **one render path**. `SCHEMAS` keys each kind:

```js
const SCHEMAS = {
  projects:   { fetch, columns, rowHref, canDelete: true,
                canDeleteRow, deleteOne, saveEdit },
  files:      { fetch, columns, rowHref, canDelete: true,
                deleteOne, saveEdit },
  reports:    { fetch, columns, rowHref, canDelete: true,
                deleteOne, openEditor, addHref, saveEdit },
  dashboards: { fetch, columns, rowHref, canDelete: true,
                deleteOne, openEditor, addHref, saveEdit },
  companies:  { fetch, columns, canDelete: true,
                deleteOne, saveEdit, addAction },
  users:      { fetch, columns, canDelete: true,
                deleteOne, saveEdit, addAction },
};
```

`canDelete` gates the whole tab; the optional `canDeleteRow(r)`
predicate gates a *single* row. `projects` uses it as
`(r) => !r.is_default` — the default project can't be deleted (the
backend enforces the same rule, `400 is_default`), so `renderTable`
emits a disabled trash button for that row and `objRowDelete` /
`objBulkDelete` skip it.

`companies` and `users` are now **full-CRUD** in dev: PATCH (inline
edit) and DELETE are both unrestricted backend-side ("we are still
developping the App, I can't have restriction"). `addAction` opens a
`window.prompt`-based create flow (lightweight stop-gap until a real
modal). Reports / dashboards likewise gained `saveEdit` →
`PATCH /api/{reports,dashboards}/:rid` for inline title / description /
favorite edits.

There's no per-schema `search` — toolbar search is generic
(`_objMatchesSearch`): it scans **every** column of the kind via
`_objColValue`, so it covers hidden-by-default columns (Project ID,
owner fields, …) and self-maintains as columns are added.

`STATE[kind]` caches each tab's `rows` / `filtered` / `search` / `page`
/ `mode` / `selected` plus its per-kind column config (`colOrder`,
`visibleCols`). `loadTable(kind)` fetches via the schema, then
`renderTable(kind)` filters by **search + the predicate filter +
favorites**, paginates, and paints header + body from the **visible,
ordered** columns (`_visibleOrderedCols`).

All six kinds carry trailing **row-open buttons** — see *Per-row open
buttons* below.

The `files` schema renders the parent project name via the
`projectName()` helper — that's why `mount()` prefetches `projects`
even when landing on another tab.

### Columns — every DTO field is available

Each schema's `columns` array now carries one entry per useful DTO
field. The columns shown by default are unflagged; everything else is
`hidden: true` — present in the **Columns** dropdown / Column-order but
off until the user toggles it on. `_ensureColState` seeds
`visibleCols` from the non-`hidden` set. Examples of the hidden extras:
`projects` → Description, Project ID, Owner, Username, Default;
`files` → Type, Encoding, Delimiter, Created, Project ID, File ID
(`Stage` ships visible by default); `reports` / `dashboards` →
Description, Created, Source file, Project ID, the RID; both also
expose **Owner** / **Username** columns sourced from a backend LEFT
JOIN — see *Owner join (reports / dashboards)*.

### Column sort — chained, shift-click to extend

Every header is a sort target. `STATE[kind].sorts` is an **ordered
chain** of `{ col, dir }` entries (primary first, remaining keys
break ties) — mirroring the Rust backend's `PageQuery.sorts` JSON
shape so the cleaner's wiring stays symmetric:

| Click | Behaviour |
|---|---|
| **Plain click** on a header | Replace the whole chain with `[{col, asc}]`. If the column is already the *sole* key, flip its `dir` instead. |
| **Shift-click** on a header | Append the column at `asc`. If it's already in the chain, flip its `dir`. **Alt+shift-click** removes it. |

Active headers carry `.rp-rt-sort-th` + an `.rp-rt-sort-active` arrow
(`bi-arrow-up` / `bi-arrow-down`); inactive ones show a faded
`bi-arrow-down-up` hint that brightens on hover. When the chain has
**more than one key**, each active header also renders a small accent
rank pill (`.rp-rt-sort-rank` — "1", "2", …) so primary / tie-breaker
order is visible at a glance.

The sort runs client-side via `_objColValue` so it covers the file
schema's render-only keys (`filename` / `project` / `cleanness` /
`file_size`) without per-schema accessors. Per-cell-pair comparator
is numeric when both sides parse as finite numbers, locale-string
otherwise; nulls / empty strings always sink, regardless of direction.

`STATE[kind].sorts` is per-tab. Saved views serialise it as
`sorts: [{col, dir}, …]` so `objSave` persists the whole chain;
legacy single-key `sort: { col, dir }` views are still accepted on
load and migrated to a 1-element chain. Click on the
`.rp-rt-col-resize` grip bubbles `event.stopPropagation()` so a grip
click never sorts the column.

### Resizable columns

Ported from the Django datatable: every `<th>` carries a 6 px hit
`.rp-rt-col-resize` grip on its right edge plus a stable
`data-rt-col="<key>"` attribute. `_objInitColResize` wires
`pointerdown` → `pointermove` → `pointerup` against the grip; the
`STATE[kind].colWidths[key] = px` map persists the width through
re-renders. Data cells render with `text-overflow: ellipsis;
overflow: hidden` so a narrowed column truncates rather than reflowing
the row. The widths are per-tab in `STATE` — they don't ride the saved
view (yet) and don't persist across reloads.

---

## Toolbar controls

| Control | Handler | Behavior |
|---|---|---|
| Filter | `objToggleFilter(btn)` | Slides the predicate **filter side panel** open / closed; lights the funnel button; seeds one empty predicate row on first open. See below. |
| Search | `objSearch(input)` | Client-side filter via `_objMatchesSearch(kind, row, q)` — case-insensitive, scans every column of the kind (including hidden-by-default ones) through `_objColValue`. |
| Edit / Select / Delete | `objToggleMode` | Three icon-button toggles (`<button data-rt-mode="…">`, `.is-active` + `aria-pressed` flip on click). Mutually exclusive. See *Edit / Select / Delete modes*. |
| Refresh | `objRefresh(btn)` | Re-runs `loadTable(currentKind)`; spins the icon via the library's `rp-rt-refreshing` class. |
| Row numbers | `objToggleRowNums(btn)` | Toggles a leading `#` index column. Page-aware (`start + i + 1`). Resets per tab. |
| Favorites | `objToggleFav(btn)` | Filters to `is_favorite` rows. **Shown only on the Reports / Dashboards tabs** — `objActivateTab` toggles the button's `display` per kind, and resets `objFavOnly` on every tab switch (a kind with no `is_favorite` field would otherwise filter to nothing). |
| **Score files** | `objScoreFiles(btn)` (`#obj-score-btn`, files tab only) | `POST /api/files/:rid/cleanness` for every file in the current filtered view that lacks a `cleanness_pct`. Spinner runs while in-flight, then refreshes. |
| **Clear scores** | `objClearFileScores(btn)` (`#obj-clear-score-btn`, files tab only) | `DELETE /api/files/:rid/cleanness` for every file in the view that *has* a score — nulls them out so the next Score pass recomputes from scratch. Bulk variants `objBulkScore` / `objBulkClearScores` operate on `STATE.files.selected` when select-mode is on. |
| Add | `objAdd()` | Kind-aware — reports / dashboards open their builder's "new" mode via `schema.addHref`; projects / files open the **upload modal** (`_objOpenUploadModal`, see below); companies / users now run `schema.addAction()` (a `window.prompt`-based create flow → `POST /api/{companies,users}`). |
| Rows-per-page | `objToggleDd` / `objSetRows(item, n)` | 10 / 25 / 50 / All. Pill dropdown. |
| Date format | `objToggleDd` / `objSetDateFmt(item, fmt)` | `relative` / `date` / `datetime`. **Module-wide** (one setting for all tabs); `fmtDate()` reads it, re-renders the active tab. |
| Columns | hover dropdown → `objToggleCol(cb)` | Show / hide columns. Per-tab; the checkbox list is rebuilt by `objBuildColsDropdown()` on every tab switch. Min-1 — the last visible column can't be unchecked. |
| Column order | hover dropdown, drag | Drag to reorder visible columns; rewrites `STATE[kind].colOrder`. List rebuilt by `objBuildColOrderList()` on tab switch + on any visibility change. |

**Dropdown behavior** — the Columns / Column-order dropdowns
(`.rp-rt-cols-wrap`) are **pure hover**: they open on hover and close
on hover-out, by library CSS rule. Their trigger buttons carry **no
`onclick`** — a click handler would pin them open via `.open` and break
the hover-to-close. The rows / date-format **pill** dropdowns *do* use
`objToggleDd` (click to open). `objToggleDd` is generalized to handle
both `.rp-rt-pill-dd` and `.rp-rt-cols-dd` — the trigger's next sibling
is always the dropdown panel.

**Glass control treatment** — every redtable control (toolbar buttons,
pill dropdowns, mode icon buttons, search, back button, row actions) is
restyled in `objects.css` to a transparent-fill / `--over1`-border /
`--sub`-text "glass" look, with a translucent-white hover. A
filled-translucent control picks up the panel backdrop's hue and reads
muddy; transparent + bordered stays neutral. The rules are un-scoped
but `objects.css` only loads on this route, so they can't leak — and
they keep the library's active-state specificity intact.

**Glass overlay scoping.** The same rules now also tint the page's
`#page-objects` header (`.rp-rt-topbar`), the toolbar bar, and the
`.obj-tabs` strip with a translucent backdrop + blurred underlay —
matching the Cleaner page's chrome. The selectors are scoped to
`#page-objects` so they can't leak into other redtables embedded in
non-Objects pages.

---

## Per-row open buttons

Every row carries a **leading** `.obj-row-open-cell` (first column of
both `<thead>` and `<tbody>`, `text-align: left`) with one or more
icon links emitted by `_objRowOpenButtons(kind, row)`:

| Kind | Buttons | Where they go |
|---|---|---|
| `files` | 🪄 cleaner, then stage-gated 📊 report / 📐 dashboard | `#/cleaner?id=…`; report / dashboard links appear only once the file's stage advances past `clean` (`_objStageRank` map: `import < clean < report < publish`). |
| `projects` | 🪄 cleaner | `#/cleaner?project=…` — lands on the project's Overview pane. |
| `reports` | 📊 report builder | `#/reports?id=…`. |
| `dashboards` | 📐 dashboard builder | `#/dashboards?id=…`. |
| `companies` / `users` | — | No detail page yet. |

All open in a new browser tab (`target="_blank"`). Clicking a row no
longer opens anything — that auto-navigation was UX-unfriendly
(accidental clicks bounced you out of the page); the open intent is
now explicit. The button column is **always emitted** and lives outside
the select / delete mode columns so it doesn't collapse when modes
toggle. The cell was originally trailing — it now sits at the row's
start so users land on the actions at the natural left edge instead
of scanning to the end.

---

## Projects-tab cell anchors

On the Projects tab specifically, the **Name** and **Project ID**
columns render their value through `<a class="obj-cell-link"
href="#/cleaner?project=<rid>" target="_blank">…</a>` — same href as
`rowHref`, plus native anchor semantics so middle-click / cmd-click
"open in new tab" works. `onclick="event.stopPropagation()"` defends
against any future row-level click handler. The `obj-cell-id` variant
adds a monospace font for the RID column; both classes inherit the
cell's text color + size so they theme cleanly in light / dark.

---

## Drag-to-reorder — tabs

Every `.obj-tab` in the tab strip is `draggable="true"` — drop on
another tab inserts source BEFORE target (Mac Finder / Excel
convention, same as the column-drag pattern). `objTabDrag*` handlers
mirror `objColDrag*`; on drop, `objTabs` is spliced and persisted via
`rpSavePref("objects_tabs", …)` so the new order shows up immediately
in Profile's Settings panel too. Cues:
`.obj-tab-drag` (source: 40% opacity + accent tint) /
`.obj-tab-drop` (target: inset accent left border = "insert here").

The same drag pattern is mirrored on **Profile → Settings → Object
tabs** — active pills are reordered to match the user's preferred
order (inactive pills follow in catalog order) and the active ones
are draggable. Both surfaces write the same `prefs.objects_tabs` pref.

---

## Drag-to-reorder — columns

Every data `<th>` (those with `data-rt-col`) is `draggable="true"`
too. `objColDrag*` handlers splice `state.colOrder` in place; the
Save view button persists into `prefs.objects_views` (no per-drag
PATCH). Same cue classes (`.rp-rt-th-drag` / `.rp-rt-th-drop`) reused
from the cleaner's column-drag pattern. The drag is compatible with
the existing **Column-order** hover dropdown — `objBuildColOrderList`
re-renders after a drop so both UIs reflect the new layout.

---

## Star toggle — `is_favorite`

Reports and dashboards expose a `Fav` column rendered as a filled /
unfilled star icon via `_objStarBtn(rid, field, on)`. Click runs
`objToggleStar(btn)`:

1. **Optimistic flip** — toggles the star icon class + the row's
   in-memory `is_favorite` immediately.
2. PATCHes the new boolean (`PATCH /api/{reports,dashboards}/:rid`,
   sparse body).
3. **Rollback on error** — flips back + toasts.

The star supersedes the Edit-mode `bool` cell for favorites: editing
your favorites was the one common toggle that wanted a one-click
affordance, not a dblclick → select → commit dance.

---

## Filter side panel — predicate filter

Opened by the toolbar funnel. `#obj-filter-panel` is a library
`.rp-rt-filter` slide-open shell with a 2-tab strip:

- **Filters** — the predicate filter. A **Match** segmented pill
  (AND / OR) over a list of `(column · op · value · ✕)` predicate rows
  (`.rp-rt-fb-row`), an *Add predicate* button, and a header with
  clear-draft (eraser), save (floppy, no-op stub — the panel's own
  named-filter feature; distinct from the header's **Save view**) and
  **Apply**.
- **Report tools** — `hidden` on the Objects page (Objects needs the
  Filter tab only). The tab + empty pane are kept so the structure
  matches the Cleaner / Report pages in the superset plan.

### Predicate row anatomy

Each `.rp-rt-fb-row` is built by `_objAppendFilterRow`:

- **Column + op** are **custom dropdowns** (`_objFbDropdown` → a
  `.rp-rt-fb-dd-btn` + a `.rp-rt-fb-dd-menu` + a hidden `[data-fb-*]`
  input). Native `<select>`s were dropped because their popup can't be
  styled to match the toolbar pills. The hidden input still carries the
  value, so `_objFilterRowChanged` / `objApplyFilter` /
  `_objRefreshFilterApply` read `.value` unchanged. The menu is
  `position: fixed` (JS-anchored by `_objFbPositionMenu`) so it escapes
  the filter panel's `overflow-y` clipping; `_objFbDdPick` commits the
  choice. Closed on outside-click, on `.rp-rt-filter-inner` scroll, and
  when the panel slides shut. **No type-ahead** — matches the toolbar
  dropdowns, which are click-only.
- **Value** is a text `<input>` with a **custom suggestion menu**
  (`.rp-rt-fb-dd-menu[data-fb-val-menu]` — same styling as the column /
  op dropdowns). A native `<datalist>` would have been simpler, but its
  popup can't be styled, so it read as a pale OS-chrome box next to the
  dark dropdowns. `_objFbValInput` (on `input` / `focus`) reshapes the
  input per op, refreshes Apply, and calls `_objShowValSuggestions` —
  which lists the distinct values of the selected column
  (`_objColDistinctValues`, capped at 50), filtered live by what's
  typed. `_objFbValPick` fires on `mousedown` (before blur, default
  prevented to keep focus) and fills the input.

All three menus — column, op, value — share `.rp-rt-fb-dd-menu`
styling, `_objFbPositionMenu` for placement, and `_objCloseFbMenus` /
the outside-click + scroll + panel-close paths for dismissal.

How it filters:

| Piece | Detail |
|---|---|
| `OBJ_FILTER_OPS` | 16 operators — `eq`/`neq`/`contains`/`starts_with`/`ends_with`/`in`/`not_in`/`gt`/`gte`/`lt`/`lte`/`between`/`before`/`after`/`is_null`/`not_null`. `_objFilterRowChanged` reshapes the value input (text → number → date → hidden) per op. |
| `objApplyFilter()` | Snapshots every complete predicate row + the Match combinator into `objPredicates` / `objCombinator`, resets to page 1, re-renders. Half-filled rows are dropped silently. |
| `_objColValue(kind, key, row)` | Raw filterable value for a column key. Most keys map straight to a row field; the `files` schema's render-only columns (`filename`, `project`, `cleanness`, `file_size`) are mapped explicitly so `SCHEMAS` stays untouched. |
| `_objRowMatchesFilter` | `renderTable`'s filter step ANDs search + favorites + this. Predicates combine `every` (AND) / `some` (OR). |
| Reset per tab | `objActivateTab` calls `objResetFilter()` — columns differ per kind, so stale predicate rows would point at columns the new tab doesn't have. The filter is **not** part of a saved view, so this always resets to a single empty row. |

---

## Edit / Select / Delete modes

Ported from the Cleaner page (`styles/pages/cleaner.css`).
`objToggleMode(btn, mode)` flips a `rp-rt-mode-<mode>` class on the
`.rp-rt-panel`; the three modes are **mutually exclusive** (the
handler walks `.rp-rt-icon-btn[data-rt-mode]` siblings to clear the
others + flip `aria-pressed` accordingly). Any mode change clears
the selection. The triplet is rendered as `<button
class="rp-rt-icon-btn" data-rt-mode="edit | delete | select"
aria-pressed="false">` — was `<label class="rp-rt-switch">` toggles
before; consolidated to icon buttons so all three redtable surfaces
(Objects, cleaner file-table, cleaner Overview) share one vocabulary.

The leading checkbox column (`data-mode-col="select"`) and trailing
trash column (`data-mode-col="delete"`) are **always emitted** by
`renderTable` — CSS collapses them unless the panel is in the matching
mode, so toggling a mode **never re-renders the table body**.

| Mode | What appears | Handlers |
|---|---|---|
| **select** | Leading checkbox column + master checkbox; ticked rows tint; toolbar selection chip (`#obj-sel-chip`) + bulk-delete button. | `objRowSelect`, `objSelectAll`, `objClearSelection`, `objBulkDelete`. Selection keyed by `redpash_id`. |
| **delete** | Trailing trash column — per-row `.rp-rt-row-del` (disabled when `schema.canDeleteRow(r)` is false). | `objRowDelete(rid)` — `confirm()` then `schema.deleteOne`. |
| **edit** | Editable cells (schema `edit` spec) get a dashed hover cue. | `objCellEdit(td)` on dblclick. |

### Edit mode — dblclick-to-edit

Each column may carry an `edit` spec. `objCellEdit` reads the cell's
`data-edit-type`:

- **`type: "text"`** — swaps the cell for an inline
  `<input class="rp-rt-cell-input">`; Enter / blur / Tab commits via
  `schema.saveEdit(rid, field, value)`, Escape cancels. Used by the
  `files` File (`display_name`), **Encoding** and **Delimiter** columns
  (→ `PATCH /api/files/:rid`) and the `projects` **Name** +
  **Description** columns (→ `PATCH /api/projects/:rid`). The pre-fill
  value is read from the **row data**, not the cell text — a cell
  rendered as a badge (e.g. a `null` Encoding) would otherwise pre-fill
  the input with the literal text "null".
- **`type: "bool"`** — swaps the cell for a Yes/No `<select>`; commits a
  real boolean. Used by the `projects` **Default** column
  (`field: "is_default"`).
- **`type: "select"`** — swaps the cell for an entity picker. The
  column's `edit.source` selects the option list: **`"users"`**
  (default — `_objOpenSelectEdit` lazy-fetches `GET /api/users`, cached
  in `objUsers`; used by `projects` **Owner** for owner reassignment)
  or **`"projects"`** (options from the prefetched `STATE.projects.rows`
  with a `GET /api/projects` fallback; used by `files` **Project** to
  move a file to another of the owner's projects, `field:
  "project_redpash_id"`). Commits the chosen `redpash_id`.
- **`type: "enum"`** — swaps the cell for a `<select>` of the column's
  static `edit.options` (`[value, label]` pairs); commits on change /
  blur, Escape restores. The cell normally renders a colored
  `.rp-badge` chip via `_objBadge` (`_OBJ_BADGE` maps each value →
  `rp-badge--*` class + label). Used by the `projects` **Status**
  column (`draft|active|archived`).
- **`type: "open"`** — hands off to `schema.openEditor(rid)`. Used by
  the `reports` / `dashboards` Title columns (no inline-editable
  metadata yet — dblclick opens the builder).

So the editable `projects` fields — Name, Description (text), Default
(bool), Owner (select), Status (enum) — commit through one sparse
`PATCH /api/projects/:rid`. The other kinds wire similarly:

- **`files`** — `display_name` / `encoding` / `delimiter` (text) and
  `project_redpash_id` (select) → `PATCH /api/files/:rid`.
- **`reports`** — `title` / `description` (text) and `is_favorite`
  (bool, also exposed as the star) → `PATCH /api/reports/:rid`.
- **`dashboards`** — same shape → `PATCH /api/dashboards/:rid`.
- **`companies`** — `name` / `slug` (text) → `PATCH /api/companies/:rid`.
  A duplicate slug returns 409 (`conflict / slug_taken`).
- **`users`** — `display_name` / `username` / `email` / `plan` (text /
  enum) → `PATCH /api/users/:rid`. A duplicate username returns 409
  (`conflict / username_taken`).

### Owner join (reports / dashboards)

`GET /api/reports` and `GET /api/dashboards` LEFT JOIN
`users u ON u.redpash_id = p.owner_id`, so every row carries
`owner_id` / `owner_display_name` / `owner_username` alongside the
report / dashboard payload. The schema exposes these as hidden-by-
default **Owner** and **Username** columns; the DTOs mark them
`Option<String>` with `#[sqlx(default)]` + `#[serde(default)]` so old
clients reading the new payload — and the backend reading rows where
the owner has been deleted — both stay happy.

**Stage badges (read-only).** Both `projects` and `files` carry a
**Stage** column rendered as a colored `.rp-badge` chip via `_objBadge`
— `import` / `clean` / `report` / `publish`. Stage is *computed*
backend-side (a file's furthest pipeline point; a project's = the max
of its files), so it has no `edit` spec and isn't writable. The
`projects` **Status** badge is editable, but the backend also overlays
a read-only `published` value (project has a public dashboard) that
`_OBJ_BADGE` renders but the edit `<select>` omits.

**Value badges.** A few render helpers surface DB values that are easy
to mistake for one another:
- `_objBoolBadge(v)` — `projects` **Default** renders a `true` (green) /
  `false` (muted) `.rp-badge`, mirroring the stored boolean so a real
  `false` isn't read as "missing".
- `_objNullable(v)` — a SQL `NULL` renders as a muted `null` `.rp-badge`
  (distinct from an empty string), non-null values render through
  `esc`. Used by `projects` **Description** and `files` **Encoding** /
  **Delimiter** / **Clean** (the latter shows the `null` badge only
  when `cleanness_pct` is unset).

`objActivateTab` clears all three mode classes on every tab switch, so
a mode never leaks across tabs.

---

## Header chrome

The panel `.rp-rt-header` carries — between the title and the `+` add
button — a live **meta** line, **Save view**, and **Export**. The
redtable demo's editor chrome (undo / redo, status badge,
overall-cleanness bar) was **dropped** from the markup: Objects is a
browse surface with no edit stack, and inline edits PATCH immediately,
so none of it has meaning here.

| Control | Handler | Behavior |
|---|---|---|
| Meta line | `_renderHdrMeta(kind)` (called from `renderTable`) | Live row count for the active tab — `8 users`, or `3 of 8 users` when a search / filter narrows the view. |
| **Save view** | `objSave()` | Snapshots the current tab's view config — `colOrder`, `visibleCols`, `rowsPerPage`, `showRowNums`, `dateFmt` — into `objViews[kind]` and persists the whole map via `rpSavePref("objects_views", …)`. Per-tab. The predicate filter is **deliberately excluded** — the filter panel has its own save button; folding it in here too would be a confusing second control for the same thing. |
| **Export** | `objExport()` | Downloads the current **filtered** view (all pages, visible columns in the user's order) as a CSV — RFC-4180 quoting, filename `{kind}-{YYYY-MM-DD}.csv`. Values come from `_objColValue`. |

### Saved views — `prefs.objects_views`

`objViews` is a per-kind map loaded in `mount()` from
`ctx.session.prefs.objects_views` (a corrupt / non-object pref is
ignored — `{}` fallback). It's re-applied on load:

- `_ensureColState(kind)` seeds `colOrder` / `visibleCols` from the
  saved view when present — **re-validated against the live schema**:
  unknown keys (renamed / removed columns) are dropped, and schema
  columns missing from the saved `colOrder` (added to the schema *since*
  the view was saved) are appended. A genuinely-new column — one absent
  from the saved `colOrder` entirely — is also seeded into `visibleCols`
  when it's non-`hidden`, so a new default column (e.g. files' **Stage**)
  flows into existing saved views instead of staying hidden. A column
  the user explicitly hid is still in the saved `colOrder` (just not in
  `visibleCols`), so this never un-hides a deliberate choice.
- `objActivateTab` reads `rowsPerPage` + `showRowNums` from the saved
  view (else the `25` / off defaults), and `dateFmt` when the saved
  view pins one (else `dateFmt` keeps its live module-wide value).

The predicate filter is **not** part of a saved view — `objActivateTab`
always calls `objResetFilter()`. Filter persistence belongs to the
filter panel's own save button. Like `objects_tabs`, `objects_views`
is an object (not a scalar), so `rpSavePref` PATCHes `/api/me` +
updates the in-memory session but skips localStorage.

---

## Upload modal

The toolbar **+** on the `projects` / `files` tabs opens
`_objOpenUploadModal` — a self-contained modal built with the shared
`openModal` helper (`scripts/ui/modal.js`), which renders the
redpash-components **glass modal** (`.rp-modal--glass` shell + `.modal`
panel, from `auth-modals.css`) inside a native `<dialog>` — the same
shell as the landing page's login / contact modals:

- **Dropzone** — `.rp-muz-dropzone` (from the library's
  `upload-zone.css`, newly `@import`ed into `objects.css`). Click or
  drag-drop; files are filtered against `_OBJ_UPLOAD_RE`
  (`csv|tsv|xlsx|xls|xlsm|xlsb|ods`), unsupported ones rejected with a
  toast.
- **Picked-file list** — `.obj-uz-file` chips, each with a remove ✕.
- **Project field** — an `.rp-rt-fb-val` input with an autocomplete
  menu (`.obj-uz-menu` — the `.rp-rt-fb-dd-menu` look, re-anchored
  `position: absolute` since the modal has no overflow clip). Suggests
  existing project names from `STATE.projects.rows`; **a name that
  isn't in the list creates that project** — the backend's
  `ensure_named_project` does the find-or-create.
- **Upload** — POSTs each file to `/api/files/upload` with
  `project_name`; on success refreshes `STATE.projects.rows` + the
  active tab so the new rows appear. (Direct upload — no client-side
  file-review analysis; that's Home's flow.)

---

## Wired vs stubbed against the backend

| Surface | Endpoint | Status |
|---|---|---|
| Projects tab | `GET /api/projects` | ✅ live |
| Files tab | `GET /api/files` | ✅ live |
| Reports tab | `GET /api/reports` | ✅ live |
| Dashboards tab | `GET /api/dashboards` | ✅ live |
| Companies tab | `GET /api/companies` (LEFT JOIN — lists all companies, `my_role` is `Option<String>`) | ✅ live |
| Users tab | `GET /api/users` (extra `company_memberships` query attached per user) | ✅ live |
| Row click → cleaner / builder | `#/cleaner?…`, `#/reports?id=…`, `#/dashboards?id=…` | ✅ live |
| File edit — rename / move to project / encoding / delimiter (edit mode) | `PATCH /api/files/:rid` (`display_name` text, `project_redpash_id` select, `encoding` / `delimiter` text) | ✅ live |
| Report / dashboard inline edit | `PATCH /api/{reports,dashboards}/:rid` (`title` / `description` / `is_favorite`, sparse COALESCE) | ✅ live |
| Star toggle (reports / dashboards) | `PATCH /api/{reports,dashboards}/:rid` (`is_favorite`, optimistic flip + rollback) | ✅ live |
| Company inline edit | `PATCH /api/companies/:rid` (`name` / `slug`, dev-permissive — no membership gate; 409 on duplicate slug) | ✅ live |
| User inline edit | `PATCH /api/users/:rid` (`display_name` / `username` / `email` / `plan`, dev-permissive; 409 on duplicate username) | ✅ live |
| Company / User create (Add toolbar) | `POST /api/{companies,users}` via `addAction` `window.prompt` | ✅ live |
| Score files / Clear scores (files tab) | `POST /api/files/:rid/cleanness` · `DELETE /api/files/:rid/cleanness` (toolbar + bulk variants) | ✅ live |
| Delete row — every kind | `DELETE /api/{files\|reports\|dashboards\|companies\|users}/:rid` (dev-permissive on companies / users) | ✅ live |
| Bulk delete | Loops the per-row deletes; reports OK / failed counts | ✅ live |
| Per-row open buttons (stage-driven) | Anchor links to `#/cleaner`, `#/reports`, `#/dashboards` (no API) | ✅ live |
| Resizable columns | client-side only (`STATE[kind].colWidths`) | ✅ live (not part of saved view) |
| Customizable tabs | `PATCH /api/me` (`prefs.objects_tabs`) | ✅ live |
| Columns / column-order / date-format / row-numbers / favorites | client-side only (`STATE[kind]` + module state) | ✅ live |
| Predicate filter panel | client-side (`objPredicates` evaluated in `renderTable`) | ✅ live |
| Project edit — name / description / `is_default` / `owner` / `status` (edit mode) | `PATCH /api/projects/:rid` (text / bool / select / `enum` edit-cell types) | ✅ live |
| `stage` badges (projects + files) | `GET /api/projects` · `GET /api/files` (`_objBadge` → `.rp-badge` chips, computed read-only) | ✅ live |
| Project `status` badge (+ `published` overlay) | `GET /api/projects` (`_objBadge`) | ✅ live |
| Header chrome — Save view | `PATCH /api/me` (`prefs.objects_views`) | ✅ live |
| Header chrome — Export | client-side CSV blob download | ✅ live |
| Header meta line | client-side (`_renderHdrMeta`) | ✅ live |
| Upload modal (+ button, projects / files) | `POST /api/files/upload` (`file` + `project_name`) | ✅ live |
| Project delete | `DELETE /api/projects/:rid` | ✅ live — default project's trash is disabled (`canDeleteRow`); backend also rejects it with `400 is_default`. |
| Role-based tab permissions | — | ⛔ not started — every catalog type is available to everyone. |
| Role-based row permissions (companies / users) | — | ⛔ intentionally disabled in dev ("we are still developping the App, I can't have restriction") — to re-add later. |

---

## Cache / refresh

Every change to the partial, CSS, JS, or any imported library component
triggers a `service-worker.js` `CACHE_VERSION` bump. Unregister the SW
+ hard-refresh (Ctrl+Shift+R) to see edits.
