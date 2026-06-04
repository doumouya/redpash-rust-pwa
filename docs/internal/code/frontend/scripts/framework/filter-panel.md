---
title: frontend/scripts/framework/filter-panel.js
source: ../../../../../../frontend/scripts/framework/filter-panel.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/filter-panel.js — Filter-panel component (B3.3)

## Purpose

The **FilterNode-AST builder**: a stack of group cards (each an AND/OR combo + a
list of predicate rows + an Add-condition button), joined by inter-group
separator pills, that reads out a `FilterNode` tree on Apply. It **composes** the
`rp-panel` shell ([panel.js](panel.md), variant `"filter"`) for the head
(Filter|Report pill tabs) + body + foot + close, then mounts its **own**
group-builder content into that body and its Clear/Apply buttons into the foot.
Generic + data-driven — `mountFilterPanel(host, config)` emits the whole
`rp-filter` structure from a config of columns + handlers; the page supplies the
columns and what Apply does (the "lego brick"). Part of the framework extraction
(CAS_37B2E1BF); consolidates the per-page filter builder the live Workspace
hand-builds with `rt-pred-*`/`rt-group-*`/`rt-chip-picker`/`rt-ac` in
`scripts/pages/workspace.js`.

## Public surface

- `mountFilterPanel(host, config)` → `{ el, panel, body, foot, getAst(), clear(),
  setColumns(cols), setOpen, setTab }`. `host` becomes the `.rp-panel` aside.
  Self-registers as `"filter-panel"`. ESM; composes
  [`mountPanel`](panel.md) (the shell), the `rp-seg--combo`
  ([seg.css](../../../styles/framework/seg.md)) AND/OR atom, the `rp-btn-icon`
  atoms (`--glass`/`--block`/`--accent`), and the `esc` util.
- `getAst()` — snapshot the live DOM builder into a `FilterNode` tree (or `null`).
  This is the **only** state that crosses to the table query.
- `clear()` — reset the builder to one empty group (no `onClear` fired).
- `setColumns(cols)` — rebuild for a fresh column set (e.g. on file load).

### Config (every section optional)

| key | shape | renders / does |
|---|---|---|
| `columns` | `[{ key, label, dtype, ops }]` | the column `<select>` + drives the op menu. `key` → the leaf `col`; `dtype` → the applicable ops; `ops` → optional wire-op allow-list narrowing the menu |
| `onApply` | `(ast) => void` | fired on Apply with the `FilterNode` tree (or `null`) |
| `onClear` | `() => void` | fired on Clear (after the builder resets) |
| `initial` | `FilterNode\|null` | reserved for a future hydrate; the builder seeds one empty group when columns exist (legacy parity) |
| `tabs` / `pills` / `onTab` / `onClose` | forwarded to `mountPanel` | the head pill strip (default Filter\|Report pills) + close |
| `valueEditors` | `{ attachAutocomplete, mountChipPicker, ctxFor(pred) }` | **cutover wiring** for the live value editors (see below) |

## How it works

- **Composes the panel shell, owns the builder.** `mountPanel` builds the
  head/tabs/body/foot/close; this component injects the `rp-field-lbl` +
  `rp-group-list` + Add-group into the **body**, and Clear/Apply into the
  **foot** — the shell is never re-ported.
- **Op catalog is the single source of truth.** The `OP_SPECS` table (ported from
  workspace.js) maps each wire-op to a label, a menu group, the dtypes it applies
  to, and a value-kind. `opsForColumn` dtype-filters it (then narrows by a
  column's explicit `ops`); `valueKindFor` picks the value-input shape (`between`
  is numeric-vs-date, date text-ops get a calendar picker).
- **Two delegated handlers** on the group list route every action: a `click`
  (Add-condition / remove-condition / remove-group / per-group AND/OR / inter-group
  AND/OR) and a `change` (column-change rebuilds the op menu + value slot;
  op-change swaps the value slot) — so the builder DOM re-renders without
  re-binding per element.
- **AND/OR is split semantics.** The per-group combo is **DOM-only** (read from
  `.rp-group-card-combo .is-active` `data-combo` at `getAst` time); the top-level
  inter-group combo is the per-mount `groupCombo` var, re-labeled across every
  `rp-group-sep` button on flip by `renderSeps`.
- **AST is a backend contract.** `predToLeaf` does per-op coercion (NaN rejection,
  date-vs-number typing, presence-op `{col,op}`, null-leaf dropping); a single
  group is handed out directly (no outer wrapper) so the wire payload stays
  byte-stable. The shape `{op, children} | {col, op, value}` matches
  `shared::filter::FilterNode` in Rust — a sloppy port would 400 the server.
- **State is per-mount.** `groupCombo`, `columns`, and the committed snapshot all
  live on the closure (not module singletons like the legacy IIFE), so two filter
  panels can coexist. The uncommitted builder state lives **entirely in the body
  DOM** until Apply snapshots it via `getAst()` — a re-render never wipes the group
  list out from under an in-progress condition.
- All dynamic content is escaped via `esc()` — column labels/keys, op labels, the
  combo text — same XSS-safe pattern as [chip-row.js](chip-row.md).

## Value editors (cutover note)

The in/not_in **chip-picker** (`rp-chip-picker*`) and the single-value
**autocomplete dropdown** (`rp-ac*`) are ported **verbatim** into
[filter-panel.css](../../../styles/framework/filter-panel.md) and emitted here as
**build-ready** markup + slots. Their live BEHAVIOR is `autocomplete.js`'s
`mountChipPicker` / `attachAutocomplete`, which today emit the `rt-*` markup. The
builder:

- emits the `rp-chip-picker` scaffold for `in`/`not_in` and the bare `rp-pred-val`
  input for single-value ops;
- reads chips straight from the DOM (`readChips` → `.rp-chip[data-value]`) so
  `getAst()` is correct **without** the live primitive;
- accepts `config.valueEditors = { attachAutocomplete, mountChipPicker, ctxFor }`
  so the page can pass the live primitives in at cutover — `wireValueSlot` then
  attaches them (and `readChips` prefers the controller's `.values()`).

At cutover, point `autocomplete.js` at the `rp-` names (or pass them via
`valueEditors`) and the slots light up; the slot markup + the `data-value` chip
contract already match what `mountChipPicker` expects, so the rewire is a name
swap.

## Drift-prone areas

- **`rp-pred` is a shared base.** The tools-panel forms reuse it as
  `rp-pred--stack` (label-on-top); that variant is ported alongside the base in
  filter-panel.css so lifting `rp-pred` doesn't break the tools forms. The legacy
  report-builder's `:not(.rt-report-measure)` grid guard is dropped — the report
  measure row is a separate concern, so the grid placements apply unguarded here.
- **Cutover pending.** The live Workspace still builds its own `rt-pred-*` filter
  panel in `scripts/pages/workspace.js` (module-scoped `activeFilter`/`groupCombo`/
  `filterCols`). At cutover, the page becomes a config-supplier: `setColumns` on
  file load, `getAst()` on Apply feeding `refetchPage`, and the `valueEditors`
  rewire.
- **`rp-pred-del` is NOT the `rp-btn-icon--sq` atom** — it's a row-local button
  shape (matches the input height, grid-stretch, accent-pink hover), ported
  verbatim rather than composed.
- The **designer-mode hide** seam (`.rp-surface.is-designer-mode .rp-panel-filter`)
  lives in [panel.css](../../../styles/framework/panel.md) (the shell), not here.

## Related

- [framework/filter-panel.css](../../../styles/framework/filter-panel.md) — the filter-specific CSS (rp-field-lbl / rp-pred* / rp-group-card* / rp-add-pred / rp-group-sep + the rp-chip-picker* / rp-ac* value editors).
- [framework/panel.js](panel.md) — the panel SHELL this composes.
- [framework/seg.css](../../../styles/framework/seg.md) — the `rp-seg--combo` AND/OR atom.
- [autocomplete.js](../autocomplete.md) — the live value-editor primitives (rewired at cutover).
- [component-registry](component-registry.md) · [framework index](index.md).
