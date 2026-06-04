---
title: frontend/scripts/framework/surface.js
source: ../../../../../../frontend/scripts/framework/surface.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/surface.js — Surface component (B2)

## Purpose

The **surface** is the chrome'd content card every railed page renders into
(Home `#rpHomeView`, Monitoring `#rpMonView`, Workspace `#wsSurface`, Cases
board) **plus** the canonical **inner assembly** those pages already share: a
head row → an optional chip-row band → a stat strip → the list table, in that
fixed order. The visual surface order was previously enforced only by the
builder call-order hand-copied into `home.js` / `monitoring.js` / `cases.js`;
`mountSurface` makes the **order itself** the component (the map's "JS builders
are the real assembler" finding). Part of the framework extraction
(CAS_37B2E1BF).

## Public surface

- `mountSurface(host, config)` → `{ el, head, chipRow, statStrip, table }`.
  `host` becomes the `.rp-surface` (its existing id / extra classes are
  preserved — e.g. `#rpHomeView`, `.rp-cases-board`). Self-registers as
  `"surface"`. ESM; **composes** the four sibling builders by direct import and
  returns each one's handle so the page can drive them after mount.

### Config (every section optional)

| key | shape | composes |
|---|---|---|
| `head` | `{ objectId, title, editable, onDelete, closeHash }` | `mountHead` ([head.js](head.md)) → `rp-head` object header |
| `chipRow` | `{ name, label, chips, onChip }` | `mountChipRow` ([chip-row.js](chip-row.md)) → `rp-chip-row` |
| `statStrip` | `{ variant, stats, chartSlots }` | `mountStatStrip` ([stat.js](stat.md)) → composite / kpi / hero strip |
| `table` | `{ columns, rows, … }` | `mountSimpleTable` ([table.js](table.md)) → `rp-table-wrap` > `rp-table` |
| `loading` | string | seeds an `rp-shell-state` placeholder, returns early |

The four section keys map 1:1 to the four sibling builders. Omit a section and
its slot is skipped (the rail's optional-section pattern).

## How it works

- **The order lives here.** `mountSurface` emits one empty slot wrapper per
  present section — `head` → `chip` → `stats` → `table` — then hands each to its
  sibling builder. The canonical assembly order is the component's whole job;
  the slot builders own each slot's markup.
- **Compose, not embed** — the same pattern `topbar.js` uses for `omni.js`: the
  surface imports `mountHead` / `mountChipRow` / `mountStatStrip` /
  `mountSimpleTable` and calls each into its slot. The siblings own their markup
  + atoms; the surface owns the container + the sequence.
- **Loading twin**: when a page has no data yet it passes `loading: "Loading…"`;
  the surface renders a single `rp-shell-state` placeholder (the chrome'd loading
  twin of the `rp-empty` atom) and returns early. The next paint (with the four
  configs) replaces it.
- **State modes are NOT handled here.** The Workspace three-mode machine
  (`is-landing-mode` / `is-designer-mode`) was removed from `mountSurface`: its
  CSS lives in the workspace/dashboards lane (`is-designer-mode` is already in
  `dashboards.css`) and the landing-mode rules port WITH the workspace surface.
  Emitting a mode class the framework can't style yet is a half-port (the verify
  flagged exactly this); the cases-overview surface uses no modes.
- **XSS-safe**: `mountSurface` interpolates no caller strings into innerHTML — it
  builds only static slot wrappers and the `esc()`-wrapped loading text; each
  sibling builder escapes its own dynamic content. Same defence-in-depth contract
  as [omni.js](omni.md) / [rail.js](rail.md).

## Drift-prone areas

- **Container chain is static HTML today.** The `.rp-shell > .rp-shell-body >
  .rp-main > .rp-surface` wrapper is authored in the page partials; `mountSurface`
  treats the passed `host` AS the `.rp-surface` (`host.classList.add`). The CSS
  for the whole chain still lives in this component's twin sheet so a future
  cutover that JS-builds the chain has a home.
- **Height-chain dependency** ([surface.css](../../../styles/framework/surface.md)
  header): the surface's flex-fill only resolves because the table component's
  wrap claims the remaining height (`flex:1; min-height:0; overflow:auto`) and the
  pager sits below at natural height. A page that mounts a surface without the
  table-wrap + pager rules ([table.js](table.md)'s sheet) gets a collapsed /
  overflowing surface.
- **`[hidden]` gotcha**: `.rp-surface` (and `.rp-cases-board` / `.rp-cases-detail`)
  set `display:flex`, so the UA `[hidden]{display:none}` LOSES. Every surface
  toggled via the `hidden` attribute carries an explicit `.X[hidden]{display:none}`
  rule in the CSS, or it stays in layout as a big empty block.
- **Modes live across two legacy sheets**: the Workspace landing rules were in
  `workspace.css`, the designer rules in `chart.css`. Both are ported into
  surface.css so the surface's full three-mode behaviour is in one place.
- **Cases double-inset coupling**: `.rp-cases-board`'s 0.875rem margin is correct
  ONLY because `.rp-main.rp-cases-main` zeroes its padding — the pair is ported
  together.
- **Shared stats grid**: `rp-hero-strip__stats` and `rp-list-composite__stats`
  share ONE rule block; the hero strip and composite strip must not
  duplicate-then-diverge it.
- **Cutover pending**: live pages still hand-build their surfaces with the
  per-page builders in `list-page.js`. At cutover each page becomes a
  four-config supplier to `mountSurface`.

## Related

- [framework/surface.css](../../../styles/framework/surface.md) — the surface's CSS (shell chain + overview + strips + states + page context overrides).
- [head.js](head.md) · [chip-row.js](chip-row.md) · [stat.js](stat.md) · [table.js](table.md) — the four sibling builders it composes.
- [topbar.js](topbar.md) — the compose-a-sibling pattern (`mountOmni`) this follows.
- [component-registry](component-registry.md) · [framework index](index.md).
