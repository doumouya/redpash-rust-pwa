---
title: frontend/scripts/framework/toolbar.js
source: ../../../../../../frontend/scripts/framework/toolbar.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/toolbar.js — Toolbar component (B3.2)

## Purpose

The **interactive control strip** above the redtable: filter + search + the
edit/select/delete modes + undo/redo/refresh/rownum + the rows-per-page pill +
columns picker + selection chip + export + history/tools. Where
[table.js](table.md) owns the base grid and [pager.js](pager.md) owns the footer,
the toolbar is the **control layer** that drives the table's `mode-*` /
`no-rownum` classes and column display from user clicks. Part of the framework
extraction (CAS_37B2E1BF); the consolidation of the toolbar the live app carries
as static HTML in `workspace.html` plus the parity strings `list-page.js` and
`tools.js` build.

`mountToolbar(host, config)` is **config-driven so one builder serves both the
full Workspace DATA toolbar and the list-view subset** — omit a config key and
that control is omitted, so there is no template fork ([[display-none-per-page]]
applied in code: one component, per-consumer config rather than per-page
branches).

## Public surface

- `mountToolbar(host, config)` → `{ el, render(config), setSelection(count) }`.
  `host` becomes the `.rp-toolbar` element. `render` re-emits the toolbar in place
  after a data change; `setSelection(count)` updates just the sel-chip count +
  visibility without a full re-render. Self-registers as `"toolbar"`. ESM; composes
  `bindMenu` ([menu.js](menu.md)) and the `esc` util.

### Config (every section optional)

| key | shape | renders |
|---|---|---|
| `variant` | `"data"` (default) / `"designer"` | adds `.rp-toolbar--data` / `--designer` |
| `className` | string | extra bar classes (e.g. `"rp-list-toolbar"` for list views) |
| `filterToggle` / `onFilter` | `{ active, title }` / fn | filter button (`.has-filter` when active) |
| `search` | `{ placeholder, value, onInput(q) }` | `rp-search` atom box |
| `modes` / `onMode` | `[{ mode, icon, title, active, disabled }]` / fn(mode) | `rp-toolbar-mode` buttons |
| `undoRedo` / `onUndo` / `onRedo` | `{ undoDisabled, redoDisabled }` / fns | undo + redo buttons |
| `refresh` / `onRefresh` | `{ title, disabled }` / fn | refresh button (one-shot spin on click) |
| `rownum` / `onRownum` | `{ active, title }` / fn | row-number toggle |
| `rows` / `onRows` | `{ options:[n…], value, label }` / fn(n) | rows-per-page pill + `rp-menu` |
| `cols` / `onCol` | `{ items:[{index,label,checked}], disabled, title }` / fn(index,checked) | columns `rp-menu` |
| `selChip` / `onSelChip` | `{ count, show }` / fn | selection chip |
| `export` / `onExport` | `{ items:[{fmt,label,icon}], disabled, title }` / fn(fmt) | export `rp-menu` |
| `history` | `{ items:[{label,meta,icon}], title }` | history `rp-menu` (`rp-empty` body when empty) |
| `tools` / `onTools` | `{ active, title }` / fn | tools-panel toggle |
| `designer` / `onAddChart` / `onCfgToggle` | `{ title, icon, addLabel, cfgActive }` / fns | the `--designer` variant children |

Every handler receives the relevant value (mode / page-size / format / column
index); the builder owns the DOM, the caller owns what each action *does* — the
toolbar never owns `selectedRows` / `activeSteps` / `pageSize` (those are the page
controller's closure state).

## Composes (does not redeclare)

- **`rp-search`** ([atoms.css](../../../styles/framework/atoms.md) A3) for the
  search box (was `rt-search`).
- **`rp-btn-icon` / `--glass` / `--accent`** (atoms.css A1) for every button
  (was `rt-btn`; `rp-btn-icon` is the verbatim rename). The 2rem base shape — no
  `--sq` here (no toolbar control was the 1.75rem square `rt-icon-btn`).
- **`rp-menu` + `bindMenu`** ([menu.js](menu.md), B3.0) for the 4 dropdowns
  (rows / cols / export / history). The trigger is a hand-authored `[data-dd]`
  button, the panel a `.rp-menu`; the single `bindMenu` delegate drives
  open/close (mutex + outside-click). Item picks route through the toolbar's own
  delegated handler keyed off `data-tb-rows` / `data-tb-fmt` / `data-tb-col`.
- **`rp-chip`** (atoms.css A4) for the rows-per-page pill (`.rp-toolbar-pill`
  context) AND the selection chip (`.rp-toolbar-selchip` context). The two legacy
  shapes (`rt-pill` left-label+chevron trigger; `rt-sel-chip` accent-soft count)
  both fold into `rp-chip` via `.rp-toolbar` ancestor-scoped context overrides in
  [toolbar.css](../../../../../../frontend/styles/framework/toolbar.css) — **never a parallel class**.

## How it works

- **One delegated click handler** on the toolbar root routes every action by
  `data-tb-action` (`filter` / `mode` / `undo` / `refresh` / `rownum` / `sel-chip`
  / `tools` / `add-chart` / `cfg-toggle`) plus the menu-item attributes
  (`data-tb-rows` / `data-tb-fmt`), so a `render()` can re-emit the controls
  without re-binding per element. Disabled buttons are guarded (`el.disabled`).
- **Dropdowns** are hand-authored `[data-dd]`/`.rp-menu` markup; `render()` calls
  the idempotent `bindMenu()` so the single document delegate is live for them
  (no per-toolbar wiring — same model as the live `bindDropdown`).
- **Columns picker** fires `onCol(index, checked)` on the checkbox `change` with
  `stopPropagation`, so the menu stays open while ticking multiple columns
  (matches the legacy `rebuildColsDropdown` behavior). Applying the display toggle
  to the table is the consumer's job.
- **Refresh spin** re-triggers a one-shot animation by remove → reflow → add of
  `.is-spinning` on the icon (matches the legacy `rt-spinning` trick).
- **Search** forwards the trimmed value on `input`; debounce + the JS↔Rust refetch
  cadence stay with the page controller (the builder is pixels, not data).
- All dynamic content is escaped via `esc()` — same XSS-safe pattern as
  [rail.js](rail.md) / [pager.js](pager.md) / [menu.js](menu.md).

## Drift-prone areas

- **State lives in the page, not the toolbar.** `selectedRows` / `activeSteps` /
  `activeFilter` / `pageSize` are closure vars in the page controller mutated from
  toolbar handlers, table-body handlers, and the pager. The toolbar reaches out
  only via the config callbacks; it must never own this cross-area state (the
  largest port risk per the B3.2 map).
- **`@keyframes` dedup.** The refresh spinner reuses the framework's single
  `@keyframes rp-spin` (defined in [rail.css](../../../styles/framework/rail.md),
  the rail-tab busy spinner — identical `to { transform: rotate(360deg); }`).
  toolbar.css does **not** redeclare it. The legacy `rt-spin` was duplicated across
  `toolbar.css` + `panel.css`; the framework collapses to one copy.
- **Stale id selector rebound to a class.** The legacy filter-dot CSS targeted
  `#filterToggle` (an id that never matched the live `#wsFilterToggle`); the port
  rebinds it to `.rp-toolbar .rp-btn-icon.has-filter` so it is class-hooked, not
  id-coupled.
- **Modes/rownum/cols reach into the table DOM.** The mode buttons add
  `mode-*` classes, rownum toggles `no-rownum`, the cols-picker toggles th/td
  display — all on the table, applied by the consumer from the callbacks. The
  toolbar emits the controls + fires the events; it does not touch the table.
- **No sort, no add-row.** Sort lives in the table HEADER ([head.js](head.md),
  `th.sortable`), not the toolbar; row mutation comes via the edit/delete modes
  (`set_cell` / `drop_rows` steps), not an add-row button. The B3.2 map flags both
  as seams — do not invent either control here.
- **Designer variant is a different child set.** `variant:"designer"` swaps in the
  chart-name breadcrumb + spacer + add-chart + config toggle, sharing only the bar
  layout. Whether designer stays a variant of this component or splits out is a
  chart-area decision; today it ships as a variant.

## Related

- [framework/toolbar.css](../../../../../../frontend/styles/framework/toolbar.css) — the toolbar's CSS (`rp-toolbar` / `-sep` / `-spacer` / `-mode` / `-spin` / `-pill` / `-selchip` / `-title`, + the per-page context overrides).
- [menu.js](menu.md) — the dropdown delegate (`bindMenu`) the 4 menus compose.
- [pager.js](pager.md) — the redtable footer; the page-size selector is here in the toolbar, not the pager.
- [head.js](head.md) — the table header where sort lives (toolbar has no sort).
- [component-registry](component-registry.md) · [framework index](index.md).
- Memory: [[framework-layer]] / [[compose-atoms-dont-parallel]] / [[display-none-per-page]] / [[disposability-design-principle]].
