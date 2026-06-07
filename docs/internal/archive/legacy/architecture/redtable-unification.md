---
title: Redtable unification (WS#5)
section: Internal
last modified date: 2026-05-23
---

# Redtable unification — one atom, three consumers

> **Internal — RedPash team only.** This is the spec for the next big
> architectural workstream after WS#2 (server-side filter+sort). The
> Workspace's full redtable machine and the lighter `renderListBody`
> on `/monitoring` + `/home`'s admin tabs are two parallel
> implementations of the same concept. WS#5 collapses them into one
> parameterised atom, so a new data-table surface costs a spec entry,
> not a renderer. Em's framing locked the direction
> ([conversation 2026-05-23]).

## TL;DR

1. **One atom (`.rt-surface`), N configurations.** Toolbar becomes a
   slot list; the body becomes a render mode; the pager and table
   internals are shared. Each consumer declares what it wants.
2. **No new infra.** Every component already exists — rail.css,
   toolbar.css, table.css, panel.css, pager.css. The work is moving
   the *JS* behaviour out of `workspace.js` into a mountable atom and
   making the toolbar slots optional.
3. **Three immediate consumers.** Workspace (full), Monitoring's list
   tabs (read-only, light toolbar), Home's admin tabs (same as
   Monitoring). Today they are three separate renderers; after WS#5
   they are three declarative configs.
4. **WS#2 unblocks WS#5.** Server-side filter+sort lands the Filter
   DTO + the sort contract. Both surfaces hit the same wire; that's
   the prerequisite that makes the unified body code branch-free.
5. **Bonus: the chart-primitives extraction stops being one-off.** A
   unified table atom is the right pattern that proves the
   composition story — Profile/Settings sparklines + KPI tiles follow
   the same playbook.

## 1. Why now (and not earlier)

Earlier-stage RedPash had one consumer (the cleaner). Extracting the
table prematurely would have been the kind of refactor that
`[[refactor-decompose]]` warns against — debt trap, no clear shape.

Today there are three consumers all running the same intent:
*"show records, let the user sort/filter/paginate."* The differences
are in **which toolbar buttons appear** and **whether the rows are
editable** — not in the rendering, the sort gesture, the pager
mechanics, or the column-toggle logic. That's exactly the moment for
a parameterised atom.

Doing it after WS#2 (not before) means the **sort and filter wire
shapes are settled** when the atom lands. The body code stops needing
"is this Workspace or Monitoring?" branches because the surfaces
already speak the same wire format.

## 2. The atom — `.rt-surface`

`.rt-surface` already exists in workspace.html. It is the wrapper for
toolbar + body + pager. The CSS atom is fine; the JS machinery around
it (toolbar wiring, sort-on-click, column show/hide, search filter,
selection, edit modes, pager, refresh) is what gets extracted.

### 2.1 Parameter axes

| Axis | Workspace | Monitoring · Home admin | Atom encodes how |
|---|---|---|---|
| **Toolbar slots** | search · refresh · edit/select/delete · columns · rows · filter · tools | search · refresh · columns · rows | declarative `toolbar: {...}` config |
| **Source** | `/files/:rid/page` (rid-bound) | `<endpoint>?<params>` (free-form) | a `source` adapter with `fetchPage()` and `refetch()` |
| **Row identity** | absolute row index (`row_indices`) | `redpash_id` or `id` | a `rowKey(record)` callback |
| **Sort** | client-side over loaded page (today), server (WS#2) | same | the atom emits a `sort` DTO; source adapter sends it |
| **Filter** | client AND/OR builder + filter panel | optional chip-row(s) | filter panel is a toolbar slot; chip-rows live above the toolbar |
| **Search** | page-local string match | same | always client-side over loaded page (page-local search, by design — see [handoff-frontend-datatables.md §4](../archive/handoff-frontend-datatables.md)) |
| **Column show/hide** | client toggles via CSS `display:none` | same | shared, no source-side change |
| **Selection** | multi-select drives delete | none | toolbar slot: `select: true|false` |
| **Edit** | cell `contenteditable` → `POST /files/:rid/steps` | none | edit mode is opt-in via toolbar slot |
| **Row click** | (no-op today) | drill-down into entity | callback: `onRowClick(record)` |
| **Pagination** | server | server | shared, single helper |
| **Refresh** | re-pulls the source | re-pulls the source | source adapter exposes `refetch()` |
| **Stage / status dots** | shown on file tabs in the rail | n/a | the rail is a sibling atom, not part of `.rt-surface` |

### 2.2 Proposed config shape

A consumer mounts the atom by handing it a spec:

```js
import { mountRedtable } from "/scripts/redtable.js";

const handle = mountRedtable(hostEl, {
  source: {
    kind: "page-endpoint",        // server-paged; also "rid-bound" for file-backed
    endpoint: "/admin/users",     // un-prefixed; api.js prepends /api
    pageSize: 50,
  },
  columns: [
    { key: "display_name", label: "Name",    sortable: true,  render: (u) => esc(u.display_name) },
    { key: "plan",         label: "Plan",                      render: (u) => planChip(u.plan) },
    { key: "created_at",   label: "Joined",  sortable: true,  render: (u) => fmtTime(u.created_at), dtype: "date" },
  ],
  toolbar: {
    search:  true,
    refresh: true,
    columns: true,
    rows:    [10, 25, 50, 100, "all"],
    // omit: filter, tools, edit, select, delete  (defaults to false)
  },
  chipRows: [/* same shape as today's home.js + monitoring.js chipRows */],
  rowKey: (record) => record.redpash_id,
  onRowClick: (record) => { location.hash = "#/workspace?project=" + record.redpash_id; },
});

handle.refetch();     // imperative refresh from the outside
handle.destroy();     // on page unmount
```

Workspace's mount call differs only by which toolbar slots are on:

```js
mountRedtable(hostEl, {
  source:  { kind: "rid-bound", rid: activeFileRid, pageSize: 25 },
  columns: activeColumns,         // ColumnMeta[] from /files/:rid envelope
  toolbar: {
    search:  true,
    refresh: true,
    columns: true,
    rows:    [10, 25, 50, 100, "all"],
    filter:  true,                 // opens the side panel
    tools:   true,                 // opens the cleaning tools panel
    modes:   ["edit", "select", "delete"],  // mode buttons
  },
  onCellEdit: (rid, row, column, value) =>
    api.post("/files/" + rid + "/steps", { kind: "set_cell", params: { row, column, value } }),
  onRowsDelete: (rid, indices) =>
    api.post("/files/" + rid + "/steps", { kind: "drop_rows",  params: { indices } }),
});
```

That's *the same component*. The differences are toolbar flags + two
optional callbacks. Everything else — sort, pager, column toggle,
search, selection drawing, filter panel — is inherited.

## 3. Current state

### 3.1 Workspace's machine

- [`frontend/scripts/pages/workspace.js`](../../frontend/scripts/pages/workspace.js)
  — currently ~810 LOC. Contains the rail (project/file navigator),
  the toolbar wiring, the table rendering, sort, search, filter
  builder, column toggle, selection, edit/select/delete modes,
  step-engine writes (set_cell / drop_rows), pager, refresh.
- CSS: `workspace.css` (shell), `topbar.css`, `rail.css`,
  `toolbar.css`, `table.css`, `panel.css`, `pager.css`, `chart.css`.

### 3.2 Monitoring + Home admin's renderer

- [`frontend/scripts/pages/monitoring.js`](../../frontend/scripts/pages/monitoring.js) and
  [`frontend/scripts/pages/home.js`](../../frontend/scripts/pages/home.js)
  — each has its own `renderListBody` + `fetchList` + pager. ~90 LOC
  of duplicated table machinery across the two files.
- CSS: `monitoring.css` defines `.rp-mon-panel` + `.rp-mon-table` +
  `.rp-mon-method` for the lighter table. Functionally the same
  surface as `.rt-surface` + `.rp-table`, with less furniture.

### 3.3 What's already unified (the green-field on the way)

- `.rp-chip-row` + `.rp-chip` — shared atom in `shell.css` after
  `058e4d3`. Both pages use the same markup for filter chips and
  window chips.
- `.rp-list-pager` — shared wrapper for `.rt-pages` in shell.css.
- `Page<T>` — every list endpoint returns the same shape. The atom's
  `source` adapter consumes this directly.
- `PageQuery` — every list endpoint accepts the same query params
  (`page`, `size`, plus optional `sort`, `filters`, `q`). WS#2
  finalises the rest.

## 4. Migration path — phased, each phase shippable

### Phase 0 — pin the spec (this doc)

Decisions to lock before any code moves: the parameter axes (§2.1),
the config shape (§2.2), the source-adapter interface, the naming
consolidation (§5). No code change. Output: this document, reviewed
+ signed off.

### Phase 1 — extract the toolbar

Move the workspace's toolbar wiring out of `workspace.js` into
`frontend/scripts/redtable-toolbar.js`. Takes a host element + a
slot config → mounts the buttons + exposes events
(`onSearch`, `onColumnsChange`, `onRowsChange`, `onRefresh`, etc.).
Workspace switches to consume this. Behavior unchanged.

`renderListBody` doesn't touch this yet — it keeps its plain `<table>`.

### Phase 2 — extract the table body

`frontend/scripts/redtable-body.js`. Takes columns + rows + a state
bag (sort keys, hidden columns, selection set) → renders the `<table>`
+ wires header-click sort + column show/hide + selection. Used by
the Workspace replacing the inline `renderTable` + `applySort` +
`syncSel` paths.

### Phase 3 — extract the pager

Already mostly extracted (`.rt-pages` + `.rt-pg` are shared atoms in
pager.css). Move the JS `renderPager` from workspace.js to
`redtable-pager.js`. Both `renderListBody` paths in home.js and
monitoring.js already use the same widget; they pick up the helper.

### Phase 4 — assemble `mountRedtable()`

`frontend/scripts/redtable.js` composes the three pieces (toolbar +
body + pager) + a source adapter. The first consumer is Monitoring's
list tabs: replace `renderListBody` in monitoring.js with a
`mountRedtable(...)` call. Same wire, same visuals, half the code.

### Phase 5 — migrate Home admin

Same change in home.js. Drop `renderListBody`, `fetchList`,
`renderListPager`, `pagerBtn`, `chipRowHTML`, `listPanel` — all of
that is now in the atom. Home's spec becomes a `LIST_VIEWS` table
that calls `mountRedtable(...)` per tab. The chipRows mechanism the
atom inherits from Phase 1's toolbar exposes the same API.

### Phase 6 — migrate Workspace

The big one. workspace.js's table-related code is replaced by
`mountRedtable(...)` with the full toolbar slot config + the edit /
delete callbacks. The rail stays (it's a sibling component, not part
of `.rt-surface`). After this commit, workspace.js shrinks
substantially.

### Phase 7 — retire the duplicate stylesheet

Move the worthwhile rules from `monitoring.css` (`.rp-mon-method`,
`.rp-mon-stat-chip`, `.rp-mon-panel.is-pending`, the err-band
colours) into the table/panel CSS atoms. Delete `.rp-mon-panel` and
`.rp-mon-table` — both surfaces use `.rt-surface` + `.rp-table` now.

## 5. Naming consolidation

`.rp-mon-*` was scoped to /monitoring because it didn't *want* to
collide with the workspace's `.rt-*` family. After unification it
should converge. The rule: **`.rt-*` is the redtable family, owned
by table.css + toolbar.css + panel.css + pager.css.** `.rp-mon-*`
goes away except for the tone helpers (`.rp-mon-err-low/-mid/-high`)
which are colour primitives that other pages reuse — those move to
shell.css (or a new `chips.css`) under names like `.rp-tone-ok`,
`.rp-tone-warn`, `.rp-tone-bad`. The `.rp-mon-method` "badge" class
also generalises — it's already used on Home for usernames and
file types. Rename to `.rp-badge` (or `.rp-pill`) in shell.css.

## 6. Decisions that need pinning before Phase 1

- **Source adapter interface.** Concrete shape of `fetchPage(state)`
  and `refetch()`. Probably `{ source, columns, rows, page, total,
  pages, ms }` returned from a single function call.
- **State ownership.** Who owns sort keys, hidden columns, search
  query — the consumer or the atom? Vote: atom owns runtime state,
  consumer provides initial state + receives change callbacks.
- **Edit + delete callbacks.** Async or sync? They have to be async
  to await the step-engine POST + refetchPage. The atom should
  show a "saving…" state while the callback awaits.
- **Selection model.** Multi-select by checkbox (Workspace today)
  vs. row click (some Home tabs would want this). Probably both —
  toolbar slot `select: "multi" | "single" | false`.
- **What stays out of the atom.** The rail. The greeting bar. The
  KPI strip above the table. Those are page-shell components, not
  table components. The atom takes a host element; what surrounds
  it is the page's business.

## 7. What does NOT change

- Wire format. `Page<T>` and `PageQuery` are already canonical.
- The rail (`.rt-nav`). Already a shared atom; no work needed.
- Per-page logic that lives outside the table — the Workspace's
  rail, the Home's project card grid (Projects tab), the
  Monitoring page's metrics KPI strip.
- The cleaning tools panel (`mountTools(...)`). It's already a
  side-panel atom that the redtable opens via a toolbar slot.

## 8. Open questions / spike candidates

- **Inline edits in Home admin tabs.** Should the Files / Charts /
  Steps tabs gain inline edit for metadata (rename, description)?
  That's a PATCH, not a step — different from Workspace's content
  edits. The atom can support both; question is whether to wire
  it in Phase 5 or later.
- **Server-side search.** Today every consumer's search is
  page-local. WS#2 lands server-side filter + sort; search could
  ride the same wire (`?q=`). Decide whether the atom's search
  input emits a `Filter`-shaped query or stays page-local. Probably
  page-local stays as the default and `searchScope: "server"` is
  the opt-in.
- **Bulk actions on admin tabs.** Multi-select + bulk delete on
  Users/Files/Steps? Same selection model the Workspace has — atom
  exposes it for free, page decides whether to surface it.
- **Sticky header in the redtable body.** Today the Workspace
  table doesn't have a sticky `<thead>` — the page scrolls. The
  mini-table on /login does. Cheap unification.

## 9. Cost estimate

Rough sketch, eyeballed from current LOC and the diff of comparable
component extractions in this codebase:

| Phase | New code | Code removed | Net |
|---|---|---|---|
| 1 — toolbar extract | +200 | -180 (workspace.js) | +20 |
| 2 — body extract | +300 | -280 (workspace.js) | +20 |
| 3 — pager extract | +50 | -90 (home.js + monitoring.js) | -40 |
| 4 — assemble + Monitoring migrate | +150 | -200 (monitoring.js) | -50 |
| 5 — Home migrate | +50 | -250 (home.js) | -200 |
| 6 — Workspace migrate | +100 | -350 (workspace.js) | -250 |
| 7 — CSS retirement | +40 | -180 (monitoring.css + workspace duplicates) | -140 |
| **total** | **+890** | **-1530** | **-640 LOC net** |

Plus the conceptual win — one renderer, three configurations.

## 10. Sequencing

- **Prereq**: WS#2 (server-side filter+sort) lands. Op-list
  reconciliation (Gus's current queue) is the gate.
- **Phases 0–3**: any time after WS#2. No external dependency.
- **Phases 4–6**: in sequence; each one is shippable on its own.
- **Phase 7**: cleanup; can land bundled with Phase 6 or as a
  standalone "delete the duplicates" commit.

---

**Status:** drafted 2026-05-23 by Torv after Em's framing in the
post-`058e4d3` review. Open for read; no code yet.
