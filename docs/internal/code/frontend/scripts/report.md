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

## Related

- [Frontend pillar landing](../../index.md)
