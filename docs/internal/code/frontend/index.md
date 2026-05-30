---
title: Internal · Code · Frontend — atomic docs for frontend/scripts/
section: Internal · Code · Frontend
order: 2
last modified date: 2026-05-30
---

# Frontend — atomic docs

One doc per `.js` file under `frontend/scripts/`. Mirror layout —
`frontend/scripts/path/file.js` →
[`scripts/path/file.md`](scripts/).

**Coverage at baseline (2026-05-30):** 45 atomic units, 0 documented.
Phase C (per the [plan](../../processes/atomic-doc-plan.md)) walks
this up.

## Layout

| Source dir | Files | Atomic docs | Role |
|---|---|---|---|
| `scripts/` root | 24 | [`scripts/`](scripts/) | shared utilities: api, events, dom, theme, prefs, sw-update, virtual-rows, designer, report, autocomplete, column-index, format, joins, list-page, page-row, rail-controls, rail-footer, topbar, dropdown, tools, main, wasm-engine, echarts-kpi, echarts-theme |
| `scripts/pages/` | 11 | [`scripts/pages/`](scripts/pages/) | one entrypoint per route — home, monitoring, workspace, cases, profile, settings, docs, login + sub-page modules |
| `scripts/charts/` | 5 | [`scripts/charts/`](scripts/charts/) | chart-pipeline atoms: build, render, builder-ui, home-bank, monitoring-bank |
| `scripts/tools/` | 3 | [`scripts/tools/`](scripts/tools/) | cleaner tool config: catalog, actions, fields |
| `scripts/report/` | 1 | [`scripts/report/`](scripts/report/) | report-builder UI |
| `scripts/audit/` | 1 | [`scripts/audit/`](scripts/audit/) | client-side snapshot utility consumed by audits |

## Reading order for new contributors

1. [`scripts/main.md`](scripts/) — entry point + router
2. [`scripts/api.md`](scripts/) — `api.get/post/patch/del` wrapper around `fetch`
3. [`scripts/pages/workspace.md`](scripts/pages/) — the unified-surface page (largest)
4. [`scripts/charts/render.md`](scripts/charts/) — chart spec → live ECharts instance

(stubs land in Phase C's first commit; deep-fill is incremental)

## Related

- [Public REDMAP — frontend section](../../../../REDMAP.md)
- [Cross-tier crossings](../../../subsystems/api-crossings.md)
- [Chart-pipeline architecture](../../../architecture/chart-pipeline.md)
