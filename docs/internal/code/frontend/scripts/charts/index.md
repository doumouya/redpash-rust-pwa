---
title: Internal · Code · Frontend · scripts/charts — atomic docs
section: Internal · Code · Frontend · scripts · charts
order: 12
last modified date: 2026-05-30
---

# scripts/charts — atomic docs

The chart pipeline atoms. Designer charts and Monitoring/Home charts
go through the same `buildOption` translator + `renderChart` spec
mounter (unified 2026-05-27 across Slices A → D2). Per-page **chart
banks** (`home-bank`, `monitoring-bank`) declare the default charts +
schema for the chart picker.

**Coverage at baseline (2026-05-30):** 5 atomic units, 0 documented.

## Files

| File | Atomic doc | Role |
|---|---|---|
| `build.js` | [build.md](build.md) | `buildOption(cfg, theme)` — cfg vocabulary → ECharts option; 14 THEMES + per-kind builders |
| `render.js` | [render.md](render.md) | `renderChart(el, spec, theme)` — fetches data per `source` discriminant + injects into cfg; `resolveData`, `applyTransform`, `readPointer`, `synthesizeOption` |
| `builder-ui.js` | [builder-ui.md](builder-ui.md) | `mountBuilder` accordion — the Designer + Settings chart-builder UI |
| `home-bank.js` | [home-bank.md](home-bank.md) | `HOME_STATS_SCHEMA` + `HOME_DEFAULT_CHARTS` per Home tab |
| `monitoring-bank.js` | [monitoring-bank.md](monitoring-bank.md) | `MON_STATS_SCHEMA` + `MON_DEFAULT_CHARTS` per Monitoring tab |

## Pipeline shape

```
   user-saved spec OR default bank entry
       ↓
   renderChart(el, spec, theme)
       ↓ resolveData() if spec.source !== "baked"
   synthesizeOption(data, kind)
       ↓
   buildOption(cfg, theme) → ECharts option
       ↓
   echarts.init(el).setOption(option)
```

## Related

- [Scripts pillar landing](../../index.md)
- [Architecture: chart-pipeline (deferred)](../../../../architecture/) — design rationale for the unified pipeline
