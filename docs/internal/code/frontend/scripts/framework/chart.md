---
title: frontend/scripts/framework/chart.js
source: ../../../../../../frontend/scripts/framework/chart.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/chart.js — Chart tile component (B2)

## Purpose

The ECharts-backed chart **tile** shared across pages — a glass card with a
small uppercase title above a fixed-height ECharts mount slot. It is the unit
the Home / Monitoring chart strips and the Cases-board / Workspace-landing hero
strips repeat to render their charts. The framework tile is **generic +
data-driven**: `mountChartTile(host, config)` emits the entire `rp-chart-card`
structure and, when an `option` + `window.echarts` are present, mounts an
ECharts instance into the canvas and wires a resize handler — so a page just
supplies the title + an ECharts option and the builder owns the structure,
mount, and teardown (the "lego brick"). Part of the framework extraction
(CAS_37B2E1BF); the consolidation of the per-page chart cards the live app
hand-builds with `chartsStripHTML` / `compositeStripHTML` / `heroStripHTML` in
`list-page.js`.

## Public surface

- `mountChartTile(host, config)` → `{ el, canvas, chart, resize(), setOption(opt), dispose() }`.
  `host` becomes the `.rp-chart-card`. Self-registers as `"chart"`. ESM;
  composes the `rp-title` atom for the title text and the `echarts-theme.js`
  helpers (`ensureRegisteredThemes` / `chartTheme`) for the RedPash Mocha/Latte
  themes, and the `esc` util.

### Config (every field optional)

| key | shape | effect |
|---|---|---|
| `title` | string | renders the `rp-title` atom (sized by the `.rp-chart-card .rp-title` context); omit for a canvas-only card |
| `option` | ECharts option object | `setOption()` target; absent/null → faded `rp-chart-card--empty` placeholder |
| `theme` | string | overrides `chartTheme()` passed to `echarts.init` |
| `id` | string | set on the canvas — the `createListCharts` mount-lookup contract (`querySelector('#'+id)`) |

`chart` is the live ECharts instance, or `null` for an empty / echarts-less
tile (where `resize`/`setOption`/`dispose` are no-ops).

## How it works

- **Empty / no-echarts → CSS-only placeholder.** With no `option` (or no
  `window.echarts` on the page), the tile gets the `rp-chart-card--empty`
  modifier and a bare canvas (no `id`), rendering the faded dashed-border
  em-dash placeholder. No instance is created and no resize listener is bound —
  a failed or absent chart never blanks the page.
- **ECharts mount.** When an `option` is present, `ensureRegisteredThemes()` is
  fired (memoized; a cold first paint may use the ECharts default theme for a
  few ms — accepted per `echarts-theme.js`), then
  `window.echarts.init(canvas, theme || chartTheme())` and `chart.setOption(option)`.
  This mirrors the `echarts-kpi.js` `initChart` idiom so the tile picks up the
  same Mocha (dark) / Latte (light) themes as every other chart.
- **Resize.** A per-tile `window 'resize'` listener calls `chart.resize()`;
  `dispose()` removes it and disposes the instance so a torn-down tile leaks
  neither the listener nor the canvas.
- **Title composes the atom (one class).** The title markup is just
  `class="rp-title"` (atoms.css A6 owns the base); the chart sizing
  (0.6875rem / uppercase / muted / margin-bottom) is the
  `.rp-chart-card .rp-title` ancestor-context rule in `framework/styles/chart.css`
  (0-2-0, beats the atom's 0-1-0) — never a 2nd class on the element
  (CAS_37B2E1BF). `list-page.js`'s hero/composite/charts strips render the same
  `.rp-chart-card > .rp-title`.
- All caller-supplied strings reaching `innerHTML` (`title`, `id`) are escaped
  via `esc()` — same XSS-safe pattern as [rail.js](rail.md) /
  [dashboards.js](dashboards.md). The `option` is an ECharts config object
  passed to `setOption()`, never interpolated into HTML.

## Drift-prone areas

- **Verbatim CSS came from `shell.css`, NOT `chart.css`.** The live
  `rp-chart-*` rules live in `shell.css` (lines 173-285); `frontend/styles/chart.css`
  is the SEPARATE dashboards-lane designer family (`ds-*` / `rt-designer`,
  already ported to `rp-dash-*`). Porting from `chart.css` would ship the wrong
  component — the classic incomplete-port trap.
- **Canvas height is load-bearing.** `rp-chart-canvas` carries an explicit
  `11.25rem` height/min-height; ECharts sizes itself to the container, so an
  unsized canvas renders a 0px-tall chart. Never drop it.
- **Canvas `id` is a non-CSS contract.** `createListCharts.mountData` does
  `view.querySelector('#'+c.id)`; empty slots deliberately omit the id so they
  are never mounted. The builder preserves that: an empty tile gets no id.
- **Strip wrappers + KPI tiles are OUT of scope here.** The richer layout
  wrappers (`rp-list-composite` 5-cell, `rp-hero-strip` 3-col) and the `rp-kpi`
  stat-tile family are a SEPARATE component (stat-hero lane); they compose
  `rp-chart-card` but are styled + built elsewhere. This component is the single
  tile + the `rp-charts` grid wrapper only.
- **Two render backends, one card.** Monitoring's user-built charts render
  through the unified `charts/render.js` path while default spec charts use the
  `echarts-kpi.js` path; both produce the same `rp-chart-card` markup. This tile
  exposes the generic `option` seam so either backend can drive it.

## Related

- [framework/chart.css](../../../styles/framework/chart.md) — the chart tile's CSS (ported verbatim from `shell.css`).
- [echarts-theme.js](../echarts-theme.md) — `ensureRegisteredThemes` / `chartTheme` it composes.
- [echarts-kpi.js](../echarts-kpi.md) — the `initChart` idiom this tile mirrors; the live KPI option-builders.
- [framework/dashboards.js](dashboards.md) — the designer-tile twin (`rp-dash-*`), the render-first sibling.
- [component-registry](component-registry.md) · [framework index](index.md).
