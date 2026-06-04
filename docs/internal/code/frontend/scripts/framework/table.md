---
title: frontend/scripts/framework/table.js
source: ../../../../../../frontend/scripts/framework/table.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/table.js — Simple table component (B2)

## Purpose

The **simple, read-only table**: a flat `<thead>`/`<tbody>` rebuilt wholesale on
each render. This is deliberately **not** the full B3 RedTable — there is no
column sort, no selection-checkbox column, no row-number column, no inline-edit /
delete mode, no drag-reorder, no pager, and no virtualization observer. Those
interactive layers belong to a separate `rp-redtable` component that shares the
same `rp-table` base. `mountSimpleTable(host, config)` emits the entire
`rp-table-*` structure from a plain config of `columns` + `rows` (+ optional
`empty` text and `onRowClick`), so a page supplies the data and the builder owns
the structure and the one behavior the simple table has — row-click navigation.
Part of the framework extraction (CAS_37B2E1BF); the consolidation of the
Cases-overview table and its sibling static `rt-table` previews.

## Public surface

- `mountSimpleTable(host, config)` → `{ el, render(config) }`. `host` becomes the
  `.rp-table-wrap` scroll container; the `<table class="rp-table">` (or the empty
  state) is rebuilt on every `render()`. Self-registers as `"table"`. ESM;
  composes the `esc` util and the `rp-empty` / `rp-status` / `rp-mono-pill` atoms.
- `priorityDotHTML(level, label)` → string. The Priority-cell glyph helper
  (de-cased `priorityDotHTML` from cases.js); exported because the dot is a
  reusable cell glyph, not table-private.

### Config (every section optional)

| key | shape | renders |
|---|---|---|
| `columns` | `[{ key, label, kind }]` | the `<thead>` + per-cell rendering |
| `rows` | `[{ <key>: value, …, rid? }]` | one `<tr class="rp-table-row">` each; `rid` → `data-rid` |
| `empty` | string | `rp-empty` text when `rows` is empty (default `—`) |
| `onRowClick` | `(rid, tr) => void` | fires when a row carrying a `rid` is clicked |

`kind` decides the cell render: `undefined`/`"text"` → escaped text · `"num"` →
right-aligned (`is-num`) · `"priority"` → `rp-priority-dot` + level text ·
`"status"` → `rp-status` atom (tone via `row[key + "Tone"]`, e.g. `"is-active"`) ·
`"id"` → `rp-mono-pill` atom.

## How it works

- **One delegated click handler** on the persistent `host` routes row-clicks via
  `e.target.closest(".rp-table-row")` → `tr.dataset.rid`, so the table body can be
  rebuilt (`render`) without re-binding. `onRowClick` owns what the click does
  (e.g. navigate to a detail hash) — the builder only surfaces the `rid`.
- **Render is wholesale**: `render(next)` merges `next` over the mount config and
  re-sets `host.innerHTML` — matches the legacy `paintCasesOverview` rebuild. No
  in-place row diffing (that is a RedTable concern).
- **Priority dot**: `priorityDotHTML(level)` emits `<span class="rp-priority-dot
  is-{level}">`; all four tones (`is-low`/`is-medium`/`is-high`/`is-critical`) are
  in `table.css`, and `is-critical` adds the soft box-shadow ring. Unknown levels
  fall back to the muted base dot.
- **Atoms are composed, never redeclared**: empty state → `rp-empty` (A9; the
  Cases-overview `1rem` padding re-lands via the `rp-table-empty` context class),
  status cells → `rp-status` (A12), id cells → `rp-mono-pill` (A10).
- All dynamic content is escaped via `esc()` — same XSS-safe pattern as
  [rail.js](rail.md) / [dashboards.js](dashboards.md); no raw-HTML path.

## Drift-prone areas

- **Simple ≠ RedTable.** The interactive rules (`.sortable` / `.mode-*` /
  `col-chk` / `col-rownum` / drag) were intentionally left out of `rp-table`; they
  belong to the future `rp-redtable`. `rp-table-wrap` + `rp-table-state` are
  ported here (shared base) but the simple table only uses `rp-table-wrap` (and
  the `rp-empty` atom, not `rp-table-state`) — don't fold the redtable behaviors
  into this component at the redtable cutover.
- **The real scroll host historically was the surface unit's class.** The live
  Cases overview opts OUT of `rt-table-wrap` and uses `rp-overview__table` (owned
  by the SURFACE unit) for its flex-fill scroll. `mountSimpleTable` gives the
  table its own `rp-table-wrap` host; when wired into the Cases surface, the
  surface's scroll host still applies. The `.rp-cases .rp-table { width:100% }`
  context override (de-cased `.rp-cases-ov-table .rt-table`) guarantees full width
  in that host.
- **`rp-priority-dot` has no `table` in its name** — it was the hidden dependency
  `rp-cases-priority-dot` (cases.css), invisible to a name-based grep. It is a
  cell glyph reusable by the rail too; the rail-context size override
  (`.rp-rail-item .rp-priority-dot`) is kept here until the rail unit owns it.
- **Behavior-only row class.** The legacy `rp-cases-ov-row` had zero CSS — purely
  a click hook. It is generalized to `rp-table-row`; dropping it as "unused" would
  silently break row-click navigation. Hover styling comes from the base
  `.rp-table tbody tr:hover`.

## Related

- [framework/table.css](../../../styles/framework/table.md) — the table's CSS (base + wrap + state + `rp-priority-dot` + tone modifiers + Cases context overrides).
- [framework/atoms.css](../../../styles/framework/atoms.md) — `rp-empty` (A9), `rp-status` (A12), `rp-mono-pill` (A10) the cells compose.
- [component-registry](component-registry.md) · [framework index](index.md).
