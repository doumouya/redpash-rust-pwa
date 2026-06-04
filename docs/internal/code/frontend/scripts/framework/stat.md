---
title: frontend/scripts/framework/stat.js
source: ../../../../../../frontend/scripts/framework/stat.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/stat.js — Stat tile + strips component (STAT-HERO)

## Purpose

The **rp-stat tile** — a glass card holding a small uppercase label + a brand-typed
number — and the three **strip grids** that position it across the railed pages:

- **rp-stat-strip** — the standalone auto-fit `1-to-N` grid (was `rp-kpi-strip`),
  emitted directly above a list/table on Home + Monitoring.
- **rp-stat-hero** — the 3-column overview band `chart(2fr) · stats(1fr) · chart(2fr)`
  (was `rp-hero-strip`), for the Cases board + Workspace landing overviews.
- **rp-list-composite** — the 5-column sibling `[chart][chart][stats][chart][chart]`
  (name kept; already a generic `rp-` name), for Home + Monitoring.

`mountStatStrip(host, config)` emits the whole `rp-stat-*` structure from a plain
config of data — the page supplies the data, the builder owns the structure (the
"lego brick"). Part of the framework extraction; consolidates the five legacy
builders (`kpiStripHTML` / `kpiStripValuesHTML` / `compositeStripHTML` /
`heroStripHTML` / `setKpi`) that the live app still hand-builds in `list-page.js`.

## Public surface

- `mountStatStrip(host, config)` → `{ el, set(id, val) }`. `host` becomes the strip
  root (`rp-stat-strip` / `rp-stat-hero` / `rp-list-composite` by variant).
  Self-registers as `"stat-strip"`. ESM; composes the `esc` util for every dynamic
  value. `set(id, val)` fills an async tile's value in place (no-op if unmounted) —
  the framework form of the legacy `setKpi(view, id, val)`.

### Config (every section optional)

| key | shape | renders |
|---|---|---|
| `variant` | `"kpi"` \| `"hero"` \| `"composite"` (default `"kpi"`) | which strip grid |
| `stats` | `[{ label, value }]` (baked) **or** `[{ label, id }]` (async) | `rp-stat` tiles |
| `chartSlots` | number | empty `rp-chart-card` slots reserved in the flanking columns (`hero`/`composite` only) |

A tile takes **two shapes**, both supported:

- **baked** `{ label, value }` — value rendered inline, final at render
  (the hero + workspace/cases landings hold the numbers already).
- **async** `{ label, id }` — value starts as the `—` em-dash placeholder, filled
  later by `set(id, val)` (Home / Monitoring's live KPI fill).

## How it works

- **One builder, three layouts.** `variant` selects the root class + the slot
  arrangement: `kpi` = tiles only; `hero` = `[chart][stats][chart]`; `composite` =
  `[chart][chart][stats][chart][chart]`. The stats sub-grid (`rp-stat-hero__stats` /
  `rp-list-composite__stats`) is a shared 2×2 cell of 4 tiles.
- **Composes atoms, never duplicates.** The label is the `rp-label` atom in the
  `.rp-stat` context (its default margin zeroed in `stat.css` — the tile uses the
  parent flex gap). The inline run-summary chip (`rp-stat--chip`, was
  `rp-mon-stat-chip`) composes the `rp-mono-pill` atom. The brand number
  (`rp-stat-value`, 1.375rem/700) is a **new** sub-element — no atom exists for it.
- **Chart slots are reserved, not styled.** `chartSlots` emits empty,
  layout-reserving `rp-chart-card--empty` slots so the hero/composite column math
  reads correctly; the **chart unit** owns `rp-chart-card` and mounts canvases into
  them. This unit only leaves the slot in the right column.
- **Async fill via `set()`.** Id-bearing tiles render the `—` placeholder; the
  returned handle's `set(id, val)` does a host-scoped `querySelector('#'+id)` +
  `textContent` swap — scoped to the strip, so it never touches another page's DOM.
- All dynamic content is escaped via `esc()` — XSS-safe, same pattern as
  [rail.js](rail.md); the chart-slot HTML + placeholder are static literals.

## Drift-prone areas

- **The id attribute is load-bearing.** Dropping a tile's `id` breaks the async
  fill (Monitoring's live KPI updates) — the value span must keep its `id` so
  `set()` can find it. Baked tiles deliberately carry no id.
- **Hero vertical sizing depends on a class this unit does NOT own.** The hero's
  fixed-height behavior comes from the parent `.rp-overview__hero { flex-shrink:0 }`
  (the page-layout unit), not from `rp-stat-hero` itself. Standalone strips
  (`rp-stat-strip` / `rp-list-composite`) carry their own bottom margin instead.
- **No per-page CSS overrides.** The legacy sheets had zero `.rp-cases`/`.rp-mon`
  overrides of any kpi/hero class, so a single shared definition is correct — do
  not add a context-override layer for the tile/strip.
- **Cutover pending.** Live pages still call the five `list-page.js` builders; at
  cutover each page becomes a config-supplier for `mountStatStrip`.

## Related

- [framework/stat.css](../../../styles/framework/stat.md) — the tile + strip grids' CSS.
- [framework/atoms.css](../../../styles/framework/atoms.md) — `rp-label`, `rp-mono-pill` composed here.
- the chart unit — owns `rp-chart-card` mounted into the reserved slots.
- [component-registry](component-registry.md) · [framework index](index.md).
