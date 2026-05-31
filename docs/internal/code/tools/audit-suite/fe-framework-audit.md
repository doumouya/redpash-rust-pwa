---
title: tools/fe-framework-audit/audit.js
source: ../../../../../tools/fe-framework-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-05-31
---

# fe-framework-audit/audit.js

## Purpose

The **page-bound-framework detector** (CAS_9E4F134B). Surfaces FE "frameworks"
that live inside a page closure and get re-implemented per page instead of
imported from a shared layer — the code-debt alarm Em named. Turns the
hand-compiled candidate table into **measured, ranked data** ([[data-decides]])
and becomes the durable guard so the alarm can't recur silently
([[process-oriented]]).

Read-only static analysis. Acorn AST is the carve-out from
[[no-frameworks]] ([[acorn-allowed-for-static-analysis]]).

## What it detects

Walks every `frontend/scripts/**/*.js`, collecting each named function
(declaration + arrow/function-expr `const`) at **any** depth (incl. closure
scope). A function **name defined in ≥2 distinct files** is a duplication
candidate:

- **identical normalised body** across files → true copy-paste (`════`) — extract now.
- **same name, divergent bodies** (`~~`) → parallel implementations that drifted
  — often the *worse* debt (one concept, N variants).

`severity` = number of files = extraction priority.

**The headline signal is the file-pair rollup**: which two files share the most
duplicated helpers. The top pair is the framework to extract first — one shared
module collapses N reinvented helpers. (Baseline run: `home.js ↔ monitoring.js`
= 14 shared helpers; `cases.js ↔ workspace.js` = the hide/restore cluster.)

## Public surface

`node tools/fe-framework-audit/audit.js` — no args. Writes `./audit.json`
(`{ tool, ran_at, stats, findings[], pairs[] }`; `findings` is the canonical
pre-formatted shape `kind`/`finding_key`/`severity`/`detail`, ingest-ready) and
prints the file-pair rollup + the ranked per-name table to stdout.

## Drift-prone areas

- **Generic-name noise**: coincidental same-name helpers (`render`, `close`,
  `activate`, `onKey`, `set`, `mount`) appear with `~~` and divergent bodies —
  not real frameworks. Judge by the **pair clusters** + the identical-body flag,
  not raw name matches. A future refinement could denylist ultra-generic names
  or weight by body similarity.
- **Not yet ingested**: not in `tools/audit.sh`'s ingest whitelist and has no
  `explode` arm in `audit_ingest.rs` (so it won't show in
  `/api/admin/audit-catalog` yet). Follow-up: relax the `audit.run` tool CHECK
  + add the straight-projection explode arm (the payload already carries the
  canonical `findings` shape). audit.sh's glob still **runs** it in the suite.

## Related

- CAS_9E4F134B — the FE framework-layer extraction epic this serves.
- [[no-code-debt]] · [[refactor-decompose]] · [[process-oriented]] · [[data-decides]]
- [js-audit](js-audit.md) — sibling Acorn tool (module-level dead-code + dup-export;
  this one targets closure-scoped framework duplication).
