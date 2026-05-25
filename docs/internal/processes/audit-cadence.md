---
title: Audit cadence
section: Internal
order: 51
last modified date: 2026-05-25
owner: Torv
status: stub
---

# Audit cadence

> **TODO (Torv).** Formalise the existing practice into a written rule.
> The audit-tool list below was extended 2026-05-25 (Woz) to honestly
> reflect what `sh tools/audit.sh` runs today; the rest of the doc
> still needs Torv's formalisation.

The current practice (live since 2026-05-21):

1. `sh tools/audit.sh` runs every `tools/*-audit/audit.js` before each commit (auto-discovery — adding a new audit folder requires no edit to `audit.sh`)
2. Findings (from tools that emit `audit.json`) ingested into `audit.run` + `audit.finding` (the audit-storage subsystem). The `INGEST_TOOLS` list in `audit.sh` gates which tools' JSON gets persisted — extending it needs the schema's `tool` CHECK relaxed.
3. New findings trigger a small, immediate cleanup — *not* a deferred big-bang pass
4. Trend reading: `audit.run_diff()` SQL surfaces drift between runs

## Current audit suite

| Tool | What it catches | Output |
|---|---|---|
| `tools/js-audit/` | Acorn-AST scan of `frontend/scripts/` — duplicate symbols, dead modules, god-objects, pattern catalog regressions | `report.html` |
| `tools/rs-audit/` | Rust-internal — LOC per crate, repeated lines, big match blocks, pattern catalog (extracted/live/declined) | `report.html` |
| `tools/css-audit/` | CSS conflicts / duplication / orphan rules / dangling `@import`s / reachability over the @import graph | `audit.html` + `audit.json` |
| `tools/html-audit/` | Partial-HTML duplication / componentisation candidates | `audit.html` + `audit.json` |
| `tools/crossing-audit/` | JS↔Rust seam — `/api/*` calls without a route (dangling) + route-table + DTO surface diff | `report.html` |
| `tools/redtable-audit/` | Foundation `.rt-*` invariants (R-2…R-6 rules — `.rt-*` overrides outside canonical files, retired wrap/pager classes, modes:true stubs, pager-shaped non-pager classes) | stdout pass/fail |
| `tools/auth-audit/` | Auth surface invariants (cookie / session / OAuth shape) | `audit.html` + `audit.json` |
| `tools/observability-audit/` | Cross-cutting observability invariants — event capture, log levels, perf marks, error airlock; meta-check `X-AUD` (counts other tools' `audit.json` artifacts as a freshness signal) | stdout + `audit.json` |
| `tools/css-tab-compare-audit/` | Cross-tab CSS naming-leak detector — same-role-different-name candidates, mixed-prefix violations (`.rt-mon-*`), misnamed shared atoms (list-page.js atoms with page-prefix names) | `audit.html` + `audit.json` |

Added 2026-05-25: `css-tab-compare-audit` (`516fc48`). Today's
suite count: 9.

To cover (Torv):

- The "small + frequent beats big + rare" rule (`[[feedback_cleaning_cadence]]`)
- The merge gate: `audit.sh` clean → push allowed
- When to add a new audit tool (the trigger: a class of bug the existing suite missed)
- The audit-storage subsystem reference for the trend-reading side
- The `INGEST_TOOLS` schema CHECK + how to add a new tool's findings to the persisted set
