---
title: frontend/styles/framework/redtable.css
source: ../../../../../../frontend/styles/framework/redtable.css
owner: Torv
section: Internal · Code · Frontend · styles · framework
last modified date: 2026-06-04
---

# framework/redtable.css — RedTable interactive layer (rp-redtable)

## Purpose

The **interactive layers of the B3 RedTable** — sort, selection, row-number,
column drag-reorder, the three editing modes (select / edit / delete) and the
inline cell-editor widgets — that sit **on top of** the read-only `rp-table`
base ([table.css](table.md)). Part of the framework extraction (CAS_37B2E1BF);
ported **verbatim** (`rt-`/`rp-list-` → `rp-redtable-*` + state classes) from the
three legacy forks the live app forked the table into, so the cutover is a
**zero-visual-change** diff — every rule is a legacy rule with only its selector
renamed.

The three forks converge here:

- **workspace grid** — the `.rt-table` interactive family in legacy
  `styles/table.css` (multi-key numeric sort, contenteditable edit host,
  select/delete modes, rownum toggle, virtualization);
- **list views** (home / monitoring) — `.rp-list-sortable` (legacy
  `styles/shell.css`) + `.rp-list-sel` (legacy `styles/home.css`) (single-key
  string sort, rid selection, column drag-reorder);
- **the two orphan cell-editor widgets** — `.rp-cell-edit-select` /
  `.rp-cell-edit-input`, produced by [editor-chip-enum.js](../../scripts/framework/editor-chip-enum.md)
  / [editor-entity-picker.js](../../scripts/framework/editor-entity-picker.md)
  but **UNSTYLED in the live app** (the only reference was inline in the
  `typedef-acceptance.html` test page) — now given a real home here.

**CSS-only layer.** The behaviors live in the JS builder
(`scripts/framework/redtable.js`, building on `mountSimpleTable` + the
`createVirtualRows` windower + the [cell-editor.js](../../scripts/framework/cell-editor.md)
seam); the mode state lives as a **class on the table element**
(`.mode-select` / `.mode-edit` / `.mode-delete`) toggled by the toolbar area and
**read** by `renderRow`. This sheet only paints in reaction to those classes.

## Public surface

| selector | role | legacy origin |
|---|---|---|
| `.rp-redtable .rp-redtable-col-sel` / `.mode-select …` | selection checkbox column — hidden, shown only in select mode | `.rt-table .col-chk` |
| `.rp-redtable .rp-redtable-col-rownum` / `.no-rownum …` | row-number column (`min-width` anti-jitter for virtual scroll); `.no-rownum` hides it | `.rt-table .col-rownum` |
| `.rp-redtable th.is-sortable` / `.is-sorted` | sortable header (cursor / no-select; `.is-sorted` accents the active col) | `.sortable` + `.rp-list-sortable` |
| `…th.is-sortable:has(.rp-redtable-sort):hover` | **workspace** fork hover → `--rp-text-dim` (dims) | `.rt-table th.sortable:hover` |
| `…th.is-sortable:has(.rp-redtable-sort-icon):hover` | **list** fork hover → `--rp-text` (brightens) | `.rp-list-sortable:hover` |
| `.rp-redtable th .rp-redtable-sort` / `-sort-ord` | **workspace** sort chevron `<i>` + multi-key order superscript | `.rt-table th .sort` / `.sort-ord` |
| `.rp-redtable-sort-icon` (+ `.is-asc`/`.is-desc`) | **list** sort glyph (CSS content `\F285`/`\F282`, 2-state) | `.rp-list-sort-icon` |
| `.rp-redtable thead th[draggable]` / `.is-dragging` / `.is-drop-before::before` / `.is-drop-after::after` | column drag-reorder grab cursor + the accent **insertion bar** | `.rt-table thead th[draggable]` |
| `.rp-redtable-chk` | the checkbox `<input>` (accent-colored) | `.rt-chk` |
| `.rp-redtable.mode-edit td.editable` / `:hover` / `td.editable:focus` | inline-edit cell affordance (inset outline → fill → focus ring) | `.rt-table.mode-edit td.editable` |
| `.rp-redtable.mode-delete tbody tr` / `:hover` / `:hover td` | delete-mode rows (pointer + red-tinted hover) | `.rt-table.mode-delete tbody tr` |
| `.rp-cell-edit-select` / `.rp-cell-edit-input` (+ `:focus`) | the inline cell-editor `<select>`/`<input>` widgets — small, fill the cell, accent focus ring | *orphan — none in live app* |

**Composes the `rp-table` base, never redeclares it** ([table.css](table.md)):
width/collapse/tabular-nums, sticky `thead`, tbody `td` padding/border/nowrap,
the `tr { content-visibility:auto; contain-intrinsic-size }` virtualization rule,
`tr:hover`, **`.is-selected`** (the accent-soft selected-row tone — the redtable
needs nothing more, so no `.is-selected` rule is added here), the cell kinds, the
`rp-table-wrap` scroll host and `rp-table-state` placeholder. Cell content atoms
(`rp-status`, `rp-mono-pill`, `rp-empty`, `rp-priority-dot`) live in
[atoms.css](atoms.md) / table.css and are composed by `renderRow`.

## How it works

- **Mode is a table class.** `.mode-select` reveals `.rp-redtable-col-sel`;
  `.mode-edit` activates the `td.editable` affordance; `.mode-delete` arms the
  click-to-delete row hover. The three are mutually exclusive (one mode-machine,
  owned by the toolbar/page) — this sheet just reacts.
- **Two sort forks, one header class.** Both forks unify onto `th.is-sortable`
  (cursor / no-select / `.is-sorted` accent shared). The single divergence — the
  **hover tone** (workspace dims, list brightens) — is preserved verbatim by
  keying each tone on *which glyph the header carries* via `:has()`
  (`.rp-redtable-sort` = workspace chevron, `.rp-redtable-sort-icon` = list
  glyph). This keeps both forks byte-faithful without one overriding the other on
  source order.
- **The insertion bar is a pseudo-element, deliberately.** `.is-drop-before::before`
  / `.is-drop-after::after` draw a `0.3125rem` accent bar straddling the column
  edge (`left:-2px` / `right:-2px`, 2px taller than the row) — **not** an inset
  box-shadow, which would collapse against the table boundary and become
  invisible on the FIRST (drop-before) and LAST (drop-after) column (Em
  2026-05-31). Ported verbatim; it is the load-bearing affordance of the
  reorder feature Em flagged as "lost" (2026-05-25).
- **The edit layer was MISSING from the framework base.** The framework editors
  emit `class="editable"` and the mode-machine toggles `.mode-edit`, but
  `rp-table` (table.css) had no edit styling — a lifted cell rendered
  functionally-working but **visually-dead** (no focus ring, no affordance box).
  That layer (`.mode-edit td.editable` / `:hover` / `:focus`) is ported here so
  the editor finally has a framework home.
- **The orphan widgets get sensible inline-editor styling.** `.rp-cell-edit-select`
  / `.rp-cell-edit-input` fill the cell (`width:100%`, `height:1.625rem`), inherit
  the cell font, carry an accent border, and show the accent focus ring (same
  `box-shadow` token as the `rp-input` atom and the `.editable:focus` outline) —
  matching the `tools.js` Name/Datatype inline editors they parallel.

## Drift-prone areas

- **The spacer has NO rule, on purpose.** `.rp-redtable-vrow-spacer` (the
  virtualizer's spacer `<tr>`) is styled **entirely inline** by `virtual-rows.js`
  (`content-visibility:visible` on the `<tr>`, `height/padding:0/border:0` on the
  `<td>`). That inline `content-visibility:visible` is the explicit **counter**
  to the base's `tbody tr { content-visibility:auto }` — a matched pair authored
  in two files. **Do not add a CSS rule for the spacer** or the matched-pair
  contract breaks; a porter who searches for a spacer block and finds none must
  not assume it is dead.
- **The selection-column offset is data-driven, not here.** The selection column
  (`.rp-redtable-col-sel`) is a leading sentinel; the workspace sort-index magic
  (`data-sort = i + N` leading columns) and the cell-editor seam's `selectMode`
  +1 offset live in JS. This sheet styles the column; it does **not** encode the
  count. Changing the leading-sentinel count is a JS concern
  ([[sentinel-columns-in-reorder]]).
- **Two sort-glyph classes coexist by fork.** `.rp-redtable-sort` (workspace
  chevron `<i>`, swapped bi-chevron-up/down) vs `.rp-redtable-sort-icon` (list CSS
  `\F285`/`\F282` content). They are different mechanisms for the same UI concept;
  a future unification would pick one glyph path, but porting both verbatim is
  the zero-visual-change requirement for now.
- **`:has()` dependency.** The fork-specific hover tones rely on `:has()`
  (Baseline 2023). If a target browser without `:has()` ever matters, the hover
  tone would need the JS builder to stamp a fork class on the `<th>` instead.
- **Legacy still owns the live rules.** The `.rt-table` interactive family
  (table.css), `.rp-list-*` (shell.css / home.css) and the unstyled orphan
  widgets retire at the shell cutover; until then the framework twin coexists.
  The `cell-editor.js → .rt-table` reference is FW_NS_ALLOW-allowlisted
  (`tools/ui-doc-audit/audit.js`) — that selector + allowlist entry move to
  `rp-redtable` together at cutover (see CELL-EDITOR-SEAM port risks).

## Related

- [framework/table.css](table.md) — the read-only `rp-table` base this extends
  (`.is-selected`, sticky thead, the `content-visibility` virtualization rule).
- [framework/atoms.css](atoms.md) — `rp-status` / `rp-mono-pill` / `rp-empty` /
  `rp-input` (the focus-ring token the cell-editor widgets mirror), `rp-btn-icon`.
- [cell-editor.js](../../scripts/framework/cell-editor.md) — the decorate/save
  orchestrator that adds `.editable` + emits the `.rp-cell-edit-*` widgets.
- [editor-chip-enum.js](../../scripts/framework/editor-chip-enum.md) ·
  [editor-entity-picker.js](../../scripts/framework/editor-entity-picker.md) —
  the editors that produce the two orphan widgets styled here.
