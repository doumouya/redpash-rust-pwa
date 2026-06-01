---
title: frontend/scripts/report.js
source: ../../../../frontend/scripts/report.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# report.js

## Purpose

Report builder — second tab in the filter panel. Edits a ReportSpec against the open file and runs it through POST /api/group/preview (renamed from /api/reports/preview after the object-model hard refresh). Targets the full pipeline: group_by + aggregations + windows + top-N.

## Public surface

- mountReport(body, ctx) returns { refresh, apply, clear }.
- Spec: shared::report::ReportSpec (group_by, aggs, sort, windows, top_n).
- Apply renders subtotals into the preview table inline.

## Drift-prone areas

- Spec shape shared with backend; this is half of the JS<->Rust DTO crossing.
- **Measure row = predicate-row twin (2026-06-01, Em "closer UI to Predicates").** A measure row renders as `<div class="rt-pred rt-report-measure rt-report-agg">` with children `fn(.rt-pred-op)`, `col(.rt-pred-col)`, `alias(.rt-pred-val)`, `del(.rt-pred-del)` — the SAME atom set as a filter predicate row. It reuses the canonical `.rt-pred` 20-track grid; `panel.css .rt-report-measure` only SWAPS the fn/col placement (fn left, col right — the predicate places col left / op right). Layout: row 1 `[fn][col]` 50/50, row 2 `[alias 85%][del 15%]`. The inline "of" connector + its `.rt-report-measure-of` CSS were retired (a predicate row has no connector). `.rt-report-measure` is the layout + JS selector hook; `.rt-report-agg` is the change/input delegation alias — keep both.
- **Render shape contract:** `renderPreview` reads `page.subtotals.{columns,rows,total}` + `page.total`; `renderMatrix` reads `page.subtotals` long-format and assumes ONE metric per cell (`metricIdx = rowDims + colDims`). Multi-measure matrix cells, hierarchical (per-outer-group) subtotals, and an ungrouped grand-total row are NOT yet handled — tracked in the Report→Salesforce-parity case.

## Related

- [Frontend pillar landing](../../index.md)
