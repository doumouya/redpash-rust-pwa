---
title: frontend/scripts/framework/redtable.js
source: ../../../../../../frontend/scripts/framework/redtable.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-07
---

# framework/redtable.js — Converged RedTable component (B3.1)

## Purpose

The centerpiece **interactive data table**. ONE `mountRedTable(host, config)`
parameterized over the two legacy DATA-table forks that diverged in the live
app:

- **Fork A** — workspace grid (`#wsTable`): multi-key sort by column index, raw
  `contenteditable` inline edit, selection keyed by row index, virtualization
  **ON**, no column reorder.
- **Fork B** — home/monitoring list views: single-key 3-state sort by data
  col-key, `cell-editor.js` inline edit, selection keyed by rid, no
  virtualization (paged), column drag-reorder **ON**.

Fork C — the tools-panel column *manager* table — is **NOT** part of
`rp-redtable`; it is the B3.3 tools panel and is deliberately not folded in.
Part of the framework extraction (CAS_37B2E1BF); converges the
`rt-table` interactive family the live app forked three ways.

## Public surface

- `mountRedTable(host, config)` →
  `{ el, setRows(rows), setColumns(cols), setMode(m), refresh(), getSelection(), destroy() }`.
  `host` becomes the `.rp-table-wrap` scroll container holding
  `<table class="rp-redtable rp-table">`. Self-registers as `"redtable"`. ESM;
  composes `priorityDotHTML` ([table.js](table.md)), `createVirtualRows`
  ([virtual-rows.js](../virtual-rows.md)), `cellEditor`
  ([cell-editor.js](cell-editor.md)) and the `esc` util.

### Config (every section optional)

| key | shape | effect |
|---|---|---|
| `columns` | `[{key,label,kind,sortable,editable,editKey,hidden,align,…}]` | thead + cells; `kind ∈ text\|num\|status\|priority\|id` picks the composed atom |
| `rows` | `[…]` | one item per row (object → `row[col.key]`, array → `row[colIndex]`) |
| `rowKey` | `(row,i) => string` | selection/edit identity. Default `(_,i)=>String(i)` (fork A); fork B passes `r=>r.rid` |
| `sort` | `{ multi:bool, onSort(keys) }` | `keys=[{key,dir}]`; `multi=A` (shift-add), single=B (3-state) |
| `select` | `{ onChange(Set) }` | adds the leading `.rp-redtable-col-sel` checkbox column + select-all in thead |
| `rownum` | bool | adds the leading `.rp-redtable-col-rownum` `#` column |
| `edit` | `{ host:"contenteditable"\|"cell-editor", onCommit(rowKey,colKey,value,result?), spec?, chipRender?, isPlatformAdmin?, api?, onError? }` | inline edit host |
| `del` | `{ onDelete(rowKey) }` | delete-mode: clicking a row fires `onDelete` |
| `reorder` | `{ onReorder(orderedKeys) }` | column drag-reorder (`th[draggable]`) |
| `virtual` | `{ rowHeight, overscan }` | ON ⇒ compose `createVirtualRows`; OFF ⇒ render all rows |
| `empty` | string | no-rows placeholder (composes the `rp-empty` atom) |
| `getCell` | `(row,col,i) => any` | override the per-cell value read |
| `id` | string | optional id set ON the built `<table>` (not the wrap host) so a page can ID-scope tweaks (e.g. SheetWise `id:"swTable"` → `#swTable`, parity with Workspace's `wsTable`). Default: no id |

A column takes `{ key, label, kind, sortable, editable, editKey, editor,
options, render, rel, requiresAdmin, placeholder, trunc, prefix, hidden, align,
semantic_dtype }` — the edit-related fields are consumed by the cell-editor seam.

## Emitted / consumed contract

- **Emits** `<table class="rp-redtable rp-table">` → thead (select-all + rownum
  sentinels, sortable headers with `data-col-key`, `draggable` when reorder, the
  `rp-redtable-hide-th` trailing sentinel) + tbody. Each `<tr data-row-key>`
  carries the leading sentinel cells then the data cells (`data-col-key`,
  `.editable` when editable, kind-composed inner HTML).
- **State classes** the CSS ([redtable.css](../../../styles/framework/redtable.md))
  reacts to: `.is-sorted` / `.is-asc` / `.is-desc` + `.rp-redtable-sort` glyph
  (+ `.rp-redtable-sort-ord` superscript when multi & >1 key), `.is-selected`,
  `.is-dragging` / `.is-drop-before` / `.is-drop-after`, and the exclusive
  `.mode-select` / `.mode-edit` / `.mode-delete` on the table.
- **Consumes** the `rp-table` base (`styles/framework/table.css`):
  width/collapse/tabular-nums, sticky thead, `tbody tr` content-visibility,
  `.is-selected`, cell kinds, `.rp-table-wrap`. The interactive layers sit ON
  TOP — never redeclared.

## How it works

- **MODES are mutually exclusive.** `setMode("view"|"select"|"edit"|"delete")`
  toggles exactly ONE of `.mode-*` on the table (default `view` = none). Leaving
  select/edit/delete clears the selection (legacy parity); entering/leaving edit
  re-runs the cell-editor decorate (activate/strip).
- **State lives in the closure, never on the DOM.** `selected` (Set of
  rowKeys), `sortKeys`, `mode`, `columns`, `rows`. `renderRow` re-derives row
  state from the Set + mode every paint — mandatory because the virtualizer
  recycles `<tr>` nodes.
- **`renderRow` is a PURE synchronous string builder.** The virtualization hot
  loop runs it per windowed row every scroll frame; no async, no per-row
  reactivity, one `esc()` pass per dynamic value. The non-virtual path uses the
  same `renderRow`, so column alignment + delegated handlers are byte-identical.
- **Sort.** `multi` (fork A): plain click = single asc / flip; shift-click =
  add-or-flip a multi key; the superscript order number shows only when >1 key.
  single (fork B): 3-state `desc → asc → clear`. Both emit `onSort([{key,dir}])`;
  the caller owns the actual re-sort (wasm worker / server refetch).
- **Selection** is keyed by `rowKey`, so it survives sort + virtual recycling.
  Select-all spans the whole `rows` array; `syncSelectAll` sets the
  indeterminate state.
- **Edit — two hosts.** `contenteditable` (fork A): raw cells with
  focusin-snapshot / Enter-blur / Esc-revert / focusout-commit, emitting
  `onCommit(rowKey,colKey,value)`. `cell-editor` (fork B): composes
  `cellEditor.decorate`/`save` — the editor-registry dispatch is NOT
  re-implemented. The interaction quartet (focusin/keydown/focusout/change) is
  the seam's interaction layer; page side-effects (undo/redo/log) stay in the
  caller via `onCommit(…, result)`.
- **Delete mode.** A tbody click while `mode === "delete"` fires `del.onDelete`.
- **Column reorder.** `th[draggable]` dragstart/over/drop; the drop **inserts
  before the trailing sentinel** by re-ranking the columns array
  ([[sentinel-columns-in-reorder]]) — never `appendChild`-in-a-loop. Re-renders
  head + body + re-decorates, then emits `onReorder(orderedKeys)`.
- **Virtualization.** When `config.virtual` is set the tbody is driven through
  `createVirtualRows` (single scroll host = the `.rp-table-wrap`); `pauseWhile`
  protects a mid-edit cell (both a `contenteditable` cell and the cell-editor
  `select`/`input` widgets). `destroy()` detaches the scroll listener.
- All dynamic content is escaped via `esc()` — the same XSS-safe pattern as
  [table.js](table.md) / [rail.js](rail.md); there is no raw-HTML path.

## Drift-prone areas

- **Cell-editor seam selectors.** `decorateCellEditor` passes `tableRoot` (our
  `<table class="rp-redtable">`) into `cellEditor.decorate`, so the seam derives
  the tbody + `thead tr` + `tr[data-rid]` from it (the parameterized path), not
  the legacy `.rt-table`/`#rp-home-list-tbody` lookups. Rows therefore emit
  `data-rid` (mirroring `data-row-key`) under the cell-editor host so the seam's
  `tr[data-rid]` query resolves them. The legacy `id="rp-home-list-tbody"` is
  still emitted as belt-and-braces for any path that omits `tableRoot`.
- **cell-editor host pairs with `select`, not `rownum`.** The seam's TD↔col
  mapping uses a single `selectMode ? 1 : 0` leading-sentinel offset. A `rownum`
  column adds a second leading sentinel the offset doesn't account for, so the
  cell-editor host must not combine with `rownum` (fork B never did). The
  `contenteditable` host has no such constraint (it keys cells by
  `data-col-key`, not position).
- **Date-aware sort.** `data-type="date"` is emitted from `col.semantic_dtype`
  via `DATE_DTYPES`; a richer dtype catalogue lives in the workspace and is not
  re-imported here (kept minimal on purpose).
- **CSS is a sibling file.** The interactive layer styling
  (`.rp-redtable-sortable`, `.rp-redtable-col-sel/-col-rownum`, `.mode-*`,
  `.editable`/`:focus`, drag `is-drop-*`, `.rp-cell-edit-select`/`-input`) lives
  in `styles/framework/redtable.css` (owned separately). This module only EMITS
  the classes; a missing rule renders functionally-correct but visually-dead
  cells (the incomplete-port trap). Pixel verification against the live
  workspace + home Users tab is mandatory.
- **Reorder re-ranks the FULL columns list** (incl. hidden) so hidden columns
  keep their relative slots; if a future consumer needs index-stable hidden
  columns this ordering may need revisiting.

## Related

- [framework/table.js](table.md) — the SIMPLE read-only table sharing the
  `rp-table` base + `priorityDotHTML`.
- [virtual-rows.js](../virtual-rows.md) — the windowing controller it composes.
- [cell-editor.js](cell-editor.md) + [editor-registry.js](editor-registry.md) —
  the inline-edit dispatch graph the `cell-editor` host composes.
- [component-registry](component-registry.md) · [framework index](index.md).
