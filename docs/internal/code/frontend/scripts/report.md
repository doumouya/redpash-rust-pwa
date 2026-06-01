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
- **Render shape contract:** `renderPreview` reads `page.subtotals.{columns,rows,total}` + `page.total`. `renderMatrix` reads the `page.subtotals` long-format and renders **N measures per cell as sub-rows** (CAS_AF836C82 #1): `metricCols = columns.slice(rowDims+colDims)`, `cellMap[(rk,ck)] = row.slice(dimCount)` (array of K values). Each row value spans K measure sub-rows (rowspan on the row-dim cell); the measure name sits in its own "Measure" column; pivot values are the data columns. Per-row/col totals are rolled up CLIENT-side and are exact ONLY for additive fns (sum/count summed, min/max min/max-ed) — non-additive (mean/median/q1/q3/count_distinct/first/last) render "—"; the per-measure GRAND total uses the engine's `page.total` (correct for all fns). Matrix foot is NOT sticky (K foot rows would all pin to `bottom:0` and stack).
- **`count(*)` workaround in `buildSpec`:** the engine compiles count over the `"*"` sentinel (the "Count rows" measure) to `lit(1).count()`, which Polars rejects (HTTP 400). `buildSpec` rewrites EVERY `count(*)` aggregation to count a real column (`groupBy[0] || pivotBy[0] || first data column`, aliased "count") — a row-count regardless of which non-null column it targets. Drop this once the engine uses `len()` (pinged Gus). Affects all reports with an explicit Count-of-rows measure, not just the auto-added count.
- **Still NOT handled** (tracked in CAS_AF836C82): hierarchical (per-outer-group) subtotal rows, an ungrouped grand-total row (ungrouped spec returns all-null → "No rows"), and formula/computed columns.

## Related

- [Frontend pillar landing](../../index.md)
