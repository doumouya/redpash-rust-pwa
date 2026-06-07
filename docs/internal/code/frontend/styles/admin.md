---
title: frontend/styles/admin.css
source: ../../../../../frontend/styles/admin.css
owner: Torv
section: Internal · Code · Frontend · styles
last modified date: 2026-06-07
---

# styles/admin.css

## Purpose

Admin app **POSITIONING only** (the `rp-cases-*` / `rp-mon-*` / `rp-sw-*`
convention). This sheet carries **Slice B2's Database console** (`rp-dbc-*`) + the
**admin denied-surface placeholder** (`rp-adm-placeholder`). Every block on the
page is a framework component (`rp-rail` / `rp-editor` / `rp-redtable` /
`rp-chip-row` / `rp-btn-icon` / `rp-modal`); this sheet owns only **how those
components arrange inside the surface** — **no role-private classes**. Imported by
`main.css`.

## What's here

### Denied surface

- `.rp-adm-placeholder` (+ its `i`) — the centred empty-state a non-platform-admin
  sees when reaching an Admin page. Shared across the Admin app, not Database-only.

### DB Console (all `rp-dbc-*` — positioning, not roles)

- `.rp-dbc` — the page column (flex, fills the surface).
- `.rp-dbc-bar` / `-conn-name` / `-stat` / `-foot-sp` — the top connector bar
  (active database name · Test · status). `.rp-dbc-stat.is-ok` / `.is-err` colour
  the connection-test result (`--rp-ok` / `--rp-danger`); the same `-stat` class is
  reused in the footer.
- `.rp-dbc-body` — the **two-pane** grid (`minmax(11rem,15rem) 1fr`) = tables aside
  | editor+result main.
- `.rp-dbc-tables` / `-tables-head` / `-table-list` / `-table` (+ `:hover` /
  `:focus-visible` / `.is-active`) / `-table-name` / `-table-rows` — the **tables
  explorer** aside (a scrollable list of table buttons with an approx row count).
  `.rp-dbc-table` is a transparent button styled as a list row; `.is-active` is the
  picked table.
- `.rp-dbc-main` / `-editbar` / `-cols` — the **editor zone** (the column chip-row
  + the `rp-editor` card). `.rp-dbc-cols:empty { display:none }` hides the chip row
  until a table's columns load.
- `.rp-dbc-err` — the one-off result error banner (page content, not an atom role).
- `.rp-dbc-main #dbcGrid` — lets the `rp-redtable` result grid flex to fill.
- `.rp-dbc-foot` / `-foot-sp` — the **footer** row (stat readout · spacer · Pull).
- `@media (max-width: 48rem)` — the aside **stacks above** the editor (single-column
  grid, bottom border, capped height).

## Drift-prone areas

- **No role-private classes.** Everything is `rp-dbc-*` (or the shared
  `rp-adm-placeholder`) **positioning**; the `tools/uniformity-audit` guard fails
  if an unsanctioned family appears. If a block needs *role* styling, compose the
  `rp-*` atom / framework component — do **not** add a `.rp-dbc-<role>` re-skin.
- **`-stat` is shared between the bar and the footer.** The `is-ok` / `is-err`
  modifiers are authored once and reused; keep the colour semantics
  (`--rp-ok` / `--rp-danger`) if either readout moves.
- **The two-pane grid + its narrow-viewport collapse are a pair.** The
  `48rem` media query flips `-body` to a single column and re-borders `-tables`;
  edit them together so the stacked layout stays coherent.

## Related

- [pages/database.js](../scripts/pages/database.md) — the composition that mounts into these.
- [framework/editor-code.css](../scripts/framework/editor-code.md) — where the editor styling lives (composed, not re-skinned here).
- [styles/sheetwise.css](sheetwise.md) — the sibling connector-console sheet this mirrors.
