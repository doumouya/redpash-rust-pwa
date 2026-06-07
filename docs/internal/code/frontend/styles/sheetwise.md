---
title: frontend/styles/sheetwise.css
source: ../../../../../frontend/styles/sheetwise.css
owner: Torv
section: Internal · Code · Frontend · styles
last modified date: 2026-06-07
---

# styles/sheetwise.css

## Purpose

SheetWise page **POSITIONING only** (the `rp-cases-*` / `rp-mon-*` convention).
After the conform-to-shell rebuild (CAS_B747F2B6, 2026-06-05) every block on the
page is a framework component (`rp-rail` / `rp-editor` / `rp-redtable` / `rp-pager` /
`rp-chip-row` / `rp-btn-icon` / `rp-input` / `rp-modal`); this sheet owns only how
those components are arranged inside the surface. The bespoke `sw-*` role family it
replaced is gone — the editor styling moved to `framework/editor-code.css`.

## What's here (all `rp-sw-*` — positioning, not roles)

- `.rp-sw-view` (+`[hidden]`) — the two surface views (SQL · Connectors) fill the
  surface column; the `data-rail-seg` toggle shows one.
- `.rp-sw-editbar` — padding around the column chip-row + the `rp-editor` card.
- `.rp-sw-err` — the one-off result error banner (page content, not an atom role).
- `.rp-sw-foot` / `-foot-sp` / `-stat` / `-target-in` — the result footer row
  (stat readout · target-name input · save · pager). `.rp-sw-stat.is-ok` /
  `.is-err` color the Settings "Test connection" result (`--rp-ok` / `--rp-danger`).
- `.rp-sw-conn` / `-conn-guide` — the connectors guidance empty-state centering.

## Drift-prone areas

- **No role-private classes.** Everything is `rp-sw-*` positioning; the
  `tools/uniformity-audit` guard fails the build if a `sw-*` (or any unsanctioned
  family) reappears. If a block needs *role* styling, compose the `rp-*` atom — do
  not add a `.rp-sw-<role>` re-skin.
- `.rp-sw-view[hidden]` uses the attr+class specificity to beat the base
  `display:flex` — keep that selector if the view containers stay `display:flex`.

## Related

- [pages/sheetwise.js](../scripts/pages/sheetwise.md) — the composition that mounts into these.
- [framework/editor-code.js](../scripts/framework/editor-code.md) — where the editor styling now lives.
