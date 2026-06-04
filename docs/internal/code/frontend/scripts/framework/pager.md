---
title: frontend/scripts/framework/pager.js
source: ../../../../../../frontend/scripts/framework/pager.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/pager.js — Pager component (B-atom)

## Purpose

The redtable footer: a **rows-info** readout on the left + **windowed page
buttons** (`‹ 1 … n-1 n n+1 … N ›`) on the right. Part of the framework
extraction (CAS_37B2E1BF) — it **unifies** the two divergent live pager
renderers into one builder:

- `workspace.js` `renderPager()` / `pgBtn()` — closure state (`currentPage`,
  `totalPages`, `activeFileRid`), emitted only the page buttons into `#wsPages`
  (rows-info lived in a separate `#wsRowsLabel`).
- `list-page.js` `renderListPager()` / `pagerBtn()` — took a
  `{page, totalPages, total, shown, pageSize}` state object and emitted **both**
  the `rt-rows-info` span and the `rt-pages` div.

Both shared the **same** window + ellipsis algorithm; `mountPager` keeps it
verbatim and emits the list-page.js shape (rows-info span + `rp-pages` div),
which is the Workspace-parity layout. The page-size selector is **not** part of
the pager — it is a toolbar dropdown (`rp-table-toolbar`).

## Public surface

- `mountPager(host, { onPage })` → `{ el, render(state) }`. `host` becomes the
  `.rp-pager` element. Self-registers as `"pager"`. ESM; composes the `esc` util
  and the `.rp-pager` / `.rp-rows-info` / `.rp-pages` / `.rp-pg` / `.rp-pg-gap`
  CSS (ported verbatim from the `rt-pager` family).
- `render(state)` is idempotent + re-callable after any data change (matches the
  live renderers' re-render-in-place use); `state.totalPages < 1` renders the
  pager empty.
- `onPage(n)` fires when a non-disabled, non-current page button is clicked —
  the caller owns what a page change *does* (client re-slice vs server refetch).

### Render state (every optional field absent ⇒ rows-info renders empty)

| key | type | role |
|---|---|---|
| `page` | number | current 1-based page (required) |
| `totalPages` | number | page count; `< 1` ⇒ the pager renders empty (required) |
| `total` | number? | total row count (drives the rows-info readout) |
| `shown` | number? | rows on the current page (clamps the X–Y range) |
| `pageSize` | number? | rows-per-page (so we can compute the X–Y range) |

When `total` + `pageSize` are present the readout is `Rows {from}–{to} of
{total}` (or `No rows` when `total === 0`); otherwise the `.rp-rows-info` span
renders empty but still reserves the flex slot, so the pages anchor right.

## How it works

- **Window + ellipsis** (verbatim from both live renderers): `totalPages ≤ 7`
  shows every page; otherwise the visible set is `{1, last, p-1, p, p+1}` and a
  `<span class="rp-pg-gap">…</span>` is inserted wherever the index jumps by
  more than 1. Prev/next render as `<button disabled>` at the ends.
- **One delegated click handler** on the host selects `.rp-pg[data-page]`, so it
  survives `render()` re-renders without re-binding per element. Disabled buttons
  **drop** the `data-page` attr, so they're skipped naturally — the same trick
  both legacy `pgBtn`/`pagerBtn` used. `onPage(n)` receives the parsed page; the
  builder does **not** clamp/dedupe the target — the caller decides (this keeps
  the component state-free, unlike the workspace closure that also held
  `currentPage`/`totalPages`).
- **Layout via the atom CSS**: `.rp-pager` is `justify-content: flex-end`;
  `.rp-rows-info` carries `margin-right: auto` so when present it pushes itself
  to the left edge — both the rows-info shape (Workspace) and the pages-only
  shape (Home / Monitoring) render correctly without a modifier class.
- **`esc()` on the rows-info**: the only dynamic string. Page numbers are
  integers from the `totalPages` loop / `parseInt`, never user content; button
  labels are literals. Same XSS-safe contract as [rail.js](rail.md).

## Drift-prone areas

- **State ownership moved out.** The workspace renderer held `currentPage` /
  `totalPages` / `activeFileRid` in its closure and decided client-reslice vs
  refetch inside the click handler. `mountPager` is **state-free**: it renders
  whatever `state` it's handed and fires `onPage(n)` — the caller keeps the
  current page and decides the action. At cutover, workspace must pass its
  `currentPage`/`totalPages` into `render()` and move the
  `clientMode ? clientRender() : refetchPage()` branch into its `onPage`.
- **Rows-info was split in workspace.** Live workspace put the readout in a
  separate `#wsRowsLabel` ("{n} rows") outside the pager; the framework folds it
  back into the pager's `.rp-rows-info` (the list-page.js shape). At cutover the
  workspace `#wsRowsLabel` retires in favour of the pager's own span.
- **`rp-pager` closes a forward-ref seam.** `styles/framework/dashboards.css`
  already carries `.rp-surface.is-designer-mode .rp-pager { display:none }`
  (and the live `chart.css` / `workspace.css` have the `.rt-pager` equivalents
  for designer/landing mode) — naming the atom `rp-pager` is what those rules
  were waiting on. The page-mode hides stay page composition, not the atom.

## Related

- [framework/pager.css](../../../styles/framework/pager.md) — the pager's CSS (the `rp-pager` family, ported verbatim from `rt-pager`).
- [rail.js](rail.md) — sibling framework component (the delegated-click + `esc` pattern).
- [component-registry](component-registry.md) · [framework index](index.md).
