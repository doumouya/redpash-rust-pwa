---
title: frontend/scripts/framework/dashboards.js
source: ../../../../../../frontend/scripts/framework/dashboards.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/dashboards.js — Dashboards/designer view component

## Purpose

The Workspace Dashboards/designer view as one framework component — the
4th-iteration "Full Dashboards" in the port manifest (CAS_37B2E1BF, group **B4**).
A port of the legacy designer (`frontend/scripts/designer.js` + the `.ds-*` /
`.rt-designer` / `.rt-chart` block of `frontend/styles/chart.css`) onto the
**`rp-` only** namespace: dashboard-specific structure carries the `rp-dash-`
prefix (`rp-dash-shell` / `-canvas` / `-grid` / `-tile*` / `-config*` / `-sec*` /
`-span-N`), shared roles **compose the landed Layer-A atoms**, and the CSS twin is
`frontend/styles/framework/dashboards.css` (a verbatim rename of the designer block
— values + `--rp-*` tokens byte-identical, only selector NAMES change).

## Public surface

- `mountDashboardView(host, opts)` — renders the designer (canvas + 12-col tile grid +
  config accordion) into `host`. Self-registers as `"dashboards"`. Options:
  - `tiles[]` — `{title, span (3|5|6|7|12), selected?, dirty?, rid?, error?}`; an
    `error` field routes a tile to the recoverable error variant.
  - `config` (default `true`), `configTitle`, `configHidden`, `emptyText`.

ESM. Imports only `register` + `esc` (`/scripts/dom.js`). No page/designer imports.

## How it works

- **Render-first.** Emits the full `rp-dash-*` DOM from a plain `tiles[]` config so the
  sandbox proves the view rebuilds from framework parts. Each tile = head (title +
  edit/save/delete/close actions) + an **empty `.rp-dash-chart` slot**; the config
  accordion = sections with an open-by-default first section.
- **Composes shared atoms** (never redefines): `rp-title` for tile/section titles,
  `rp-btn-icon` + `rp-btn-icon--accent` for the config **Save** CTA (`rp-dash-config-save`
  is the sizing modifier on top — verbatim `ds-config-save` deltas), `rp-empty` for the
  no-tiles state (+ a `.rp-dash-grid > .rp-empty` context override restoring the
  dashboard margin/font-size/grid-column).
- **State classes** normalized to the `is-*` convention: tile `.is-selected`, accordion
  section `.is-open` (the CSS keys on `:not(.is-open)`), shell `.rp-dash-config-hidden`.

## Drift-prone areas

- **Behaviour is the SEAM, deferred to the cutover.** No ECharts, drag/resize, inline
  rename, config binding, or PUT/DELETE persistence yet — the tile body is an empty
  `.rp-dash-chart` slot the cutover fills with `echarts.init(...)`. Until the cutover,
  `designer.js` is unchanged and this is sandbox-only.
- **Dedup-deferred candidates** (kept as `rp-dash-*` full rules to stay zero-visual-change;
  an atoms pass may later collapse them): the section-header label, field label, input,
  and muted text differ in size/weight from `rp-label`/`rp-input`, so they are NOT
  collapsed now. Only `ds-input` was a byte-identical match — it composes `rp-input`.
- **Forward references**: the designer-mode rules hide the RedTable surface via
  `rp-table-toolbar` / `rp-pager` / `rp-panel--*` — owned by the **B3 RedTable** port
  (unbuilt). The references are forward-compatible; they match once B3 lands.
- **Concatenation footgun** (fixed, watch on edits): keep `//` SEAM comments *after* a
  string on the line, never on their own `+ //…` line — a comment between `+` operators
  unary-coerces the next string to `NaN`. Caught by the sandbox render, not static checks.

## Related

- `frontend/styles/framework/dashboards.css` — the component's CSS (rp- only; not doc'd per the CSS convention).
- `frontend/framework-sandbox.html` — mounts a sample board (spans 6/6/12, one selected, one error tile + the config accordion).
- [component-registry](component-registry.md) · [framework index](index.md).
- Manifest: `~/.claude/plans/hi-need-a-plan-golden-treasure.md` (B4) · Spec: `docs/full-component-version.md`.
- Legacy source being replaced: `frontend/scripts/designer.js` + `frontend/styles/chart.css` (the `.ds-*` / `.rt-designer` block).
