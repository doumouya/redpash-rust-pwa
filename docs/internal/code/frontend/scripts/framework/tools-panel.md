---
title: frontend/scripts/framework/tools-panel.js
source: ../../../../../../frontend/scripts/framework/tools-panel.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/tools-panel.js — Tools panel / column manager (B3.3)

## Purpose

The right-side **column manager** of the RedTable surface: the cleaning panel
that lists every column with its dtype / null% / unique% / sample, lets the user
**select** columns, **rename** them inline, **cast** the dtype inline, run
**global / select-scoped cleaning actions** (drop / keep / fill / change-case /
…) through in-panel sheets, and drop **fully-null rows**. It is the legacy
`tools.js` `rt-panel--tools` + `rt-tool-columns*` surface lifted into the
framework (CAS_37B2E1BF). This is **Fork C** — the per-column metadata editor —
which `redtable.js` deliberately does NOT fold in (it is not a data grid), so it
lives here as its own builder composing the same foundation.

## Public surface

- `mountToolsPanel(host, config)` → `{ el, panel, body, columnsEl, render(config),
  setSelection(keys), setOpen(bool), setTab(id) }`. `host` becomes the `.rp-panel`
  aside (variant tools). Self-registers as `"tools-panel"`. ESM; composes
  [`mountPanel`](panel.md) (the shell) and the `esc` util.
  - `render(config)` re-emits the manager body in place after a data change
    (matches the live re-render-in-place use).
  - `setSelection(keys)` replaces the selection set (column keys) without a full
    config swap; `setOpen` / `setTab` delegate to the panel shell.

### Config (every section optional)

| key | shape | drives |
|---|---|---|
| `tabs` | `[{id,label,icon,active}]` | the panel head pill strip (default Clean / Joins) |
| `columns` | `[{key,name,dtype,semantic_dtype,null_pct,unique_pct,sample}]` | the column rows |
| `summary` | `{row_count,fully_null_rows}` | the meta-strip counts + the fully-null pill |
| `dtypeOptions` | `[[value,label],…]` | the inline cast `<select>` list |
| `globalActions` / `selectActions` | `[{kind,icon,label,title,enabled,disabled,min,max}]` | the toolbar action buttons |
| `filter` | string | the current "Filter columns…" query |
| `sheet` | `{variant:"action"\|"cast"\|"step",title,icon,blurb,chips:[name…],bodyHTML,confirmLabel}` | the open in-panel sheet |
| `on*` | callbacks | `onClose` / `onTab` / `onFilter(q)` / `onToggleColumn(key,checked)` / `onSelectAll(checked)` / `onClearSel` / `onReorder(orderedKeys)` / `onResize(key,width)` / `onRename(fromKey,toName)` / `onCast(key,toDtype)` / `onAction(kind,scope)` / `onFullyNull` / `onSheetClose` / `onSheetPreview` / `onSheetConfirm` |

## How it works

- **Composes the shell, owns the body.** `mountPanel(host, { variant:"tools",
  pills:true, tabs })` builds the head (pill tabs + close) and the scrolling
  body; this component appends its `.rp-tool-columns` surface into
  `panel.body`. `.has-columns` is added at mount so the panel opens to 35vw
  (the rule lives in [panel.css](../../../styles/framework/panel.md)).
- **One delegated click handler** on `columnsEl` routes every action by
  `data-tp-action` (`action` / `clear-sel` / `fully-null` / `sheet-close` /
  `sheet-preview` / `sheet-confirm`) + the inline-edit cell openers, so the body
  can re-render (`render`) without re-binding per element. `change` /
  `input` / `keydown` / `focusout` delegates drive selection, the filter box, and
  the inline rename / cast commits.
- **Unified column identity = `data-col-key`.** The two legacy column-state
  models — the Workspace show/hide picker keyed by **nth-child INDEX** vs the
  list-page reorder keyed by **data-col-key** — converge here on `data-col-key`.
  Every row, checkbox, and TH carries it (falling back to `name` for legacy data
  with no explicit key); `onToggleColumn` / `onReorder` / `onResize` all speak
  that key, matching the `rp-redtable` reorder contract. The brittle index model
  is retired.
- **Drag-reorder reuses redtable's CSS.** The `.is-dragging` /
  `.is-drop-before` / `.is-drop-after` insertion-bar rules are **already in
  [redtable.css](../../../styles/framework/redtable.md)** — this component wires
  the `dragstart`/`dragover`/`drop`/`dragend` handlers against them (keyed by
  `data-col-key`) and emits the new visible-key order via `onReorder`; it does
  NOT re-port the CSS. Wired only when `onReorder` is supplied (build-ready).
- **All dynamic content is escaped via `esc()`** — same XSS-safe pattern as
  [rail.js](rail.md) / [toolbar.js](toolbar.md). The one trusted seam is
  `sheet.bodyHTML` (the FIELDS-rendered form markup, owned by the sibling field
  renderers that compose the `rp-pred` filter-panel family); the manager places
  it, the producer owns its own escaping.

## Composition (the foundation it reuses, never re-ports)

| atom / component | role |
|---|---|
| [`mountPanel`](panel.md) + [`panel.css`](../../../styles/framework/panel.md) | the SHELL (pill tabs + close + body + the 35vw `.has-columns` widen + designer-mode hide) |
| [`rp-redtable` / `rp-redtable-chk`](redtable.md) | the column table's base grid + the checkbox atom; the column drag-reorder CSS |
| [`rp-toolbar`](toolbar.md) | the in-panel action toolbar (a **wrap variant** — `.rp-tool-columns-toolbar` composes `.rp-toolbar` + overrides it to two rows) |
| `rp-search` / `rp-btn-icon` / `--accent` / `--sq` / `rp-empty` (atoms.css) | the filter box, action buttons, sheet foot, sheet close + selchip clear (the **`--sq` 1.75rem square** — was `rt-icon-btn`), the placeholders |
| `rp-pred` (filter-panel slice) | the sheet form fields (FIELDS renderers) — owned by the filter slice, NOT re-declared |

## Ported-verbatim classes (rt- → rp-, zero-visual-change)

`rp-col-sniff`, `rp-col-check` / `rp-col-check-all`, `rp-col-name-input`,
`rp-col-dtype-select`, `rp-tool-columns` (+ `-head` / `-meta` / `-fullynull` /
`-tablewrap` / `-table`), `rp-tool-columns-toolbar` (+ `-break` / `-nomatch` /
`-selchip` / `-selchip-clear`), `rp-tool-columns-sheet` (+ `-head` / `-title` /
`-blurb` / `-body` / `-foot` / `-chips` / `-chip`), the `rp-cast-confirm` /
`rp-step-preview` sheet variants, and the `rp-step-preview-*` diff cells — all in
[tools-panel.css](../../../styles/framework/tools-panel.md).

## Drift-prone areas

- **Atom-shape trap (checked per button).** Toolbar action buttons + sheet
  cancel/preview were `rt-btn` → `rp-btn-icon` (2rem); the **selchip clear** and
  the **sheet close** were `rt-icon-btn(--sm)` → `rp-btn-icon--sq` (1.75rem
  square). The sheet **Apply** was `rt-btn rt-btn--accent` → `rp-btn-icon
  rp-btn-icon--accent` (the foot's `flex:1` rule keys off `--accent`).
- **The manager is step-pipeline-coupled.** Rename / cast / actions / fully-null
  fire backend `/steps` + `/cast-preview` flows in the live app; this builder
  emits the events (`onRename` / `onCast` / `onAction` / `onFullyNull`) and the
  page owns the pipeline + the catalog (`dtypeOptions` is data-driven from the
  cast tool's enum — never enumerated here, per [[data-format-open-ended]]).
- **Resize + pin have NO legacy provenance.** `onResize` is a build-ready seam
  for a future consumer; the legacy app has neither a column-resize handle nor a
  column-pin. The port resisted inventing them — only show/hide + drag-reorder +
  the manager surface are real (RESIZE/PIN named in the brief are not in the
  legacy provenance).
- **Cutover pending.** Live `workspace.js` still hand-builds the tools panel via
  `tools.js` + the `rt-*` sheets. At cutover the workspace becomes a
  config-supplier; the legacy `tools.js` + `rt-tool-columns*` sheet retire then
  (the framework twin coexists until, like topbar/omni).

## Related

- [framework/tools-panel.css](../../../styles/framework/tools-panel.md) — the manager's CSS (the ported `rp-col-*` + `rp-tool-columns*` + sheets).
- [framework/panel.js](panel.md) — the panel shell it composes. [framework/redtable.js](redtable.md) — the data-grid sibling (forks A/B); the drag-reorder CSS it reuses.
- [framework/toolbar.js](toolbar.md) — the toolbar atom the in-panel toolbar composes.
- [component-registry](component-registry.md) · [framework index](index.md).
- Source of truth: `/tmp/b3-panels-map.md` (§ TOOLS-PANEL-COLOPS).
