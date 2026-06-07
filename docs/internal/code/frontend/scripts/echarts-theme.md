---
title: frontend/scripts/echarts-theme.js
source: ../../../../frontend/scripts/echarts-theme.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-06-07
---

# echarts-theme.js

## Purpose

ECharts theme registration + resolver — one chart theme per app theme. The four JSONs
`/echarts-themes/redpash-{mocha,latte,newdark,newlight}.json` (newdark/newlight generated
from mocha/latte by `tools/theme-coverage-audit/gen-chart-themes.js`, colours swapped to
the new-theme `--rp-*` token values) carry the RedPash identity so charts recolour with
the page. `ensureRegisteredThemes()` fetches all four once per page load and registers via
`echarts.registerTheme`.

## Public surface

- `ensureRegisteredThemes()` — memoised promise; **awaited in `main.js` `mount()` before any
  page renders**, because echarts bakes the theme at `init()` time (a chart created before
  registration lands keeps echarts' default palette).
- `chartTheme()` — maps `html[data-theme]` → its chart theme via `CHART_THEME` (new-dark→newdark,
  new-light→newlight, dark/catppuccin-mocha→mocha, light/catppuccin-latte→latte); no/unknown
  theme → OS preference, defaulting to the new identity.
- Theme JSON files live at `/echarts-themes/` (served by the api crate).

## Drift-prone areas

- Theme JSON paths are absolute; relocation breaks chart init silently (chart paints in default theme).
- The init-time theme bake is why `main.js` awaits `ensureRegisteredThemes()` before render —
  remove that await and cold-loaded charts revert to the echarts default palette.
- Adding a 5th app theme needs a matching `redpash-<theme>.json` + a `CHART_THEME` entry, else
  its charts fall back to the OS-preference default.

## Related

- [Frontend pillar landing](../../index.md)
