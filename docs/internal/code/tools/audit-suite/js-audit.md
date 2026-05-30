---
title: tools/js-audit/audit.js
source: ../../../../../tools/js-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-05-30
---

# js-audit

## Purpose

Frontend JS refactoring audit (v2.0 — AST Edition). A static scan of
`frontend/scripts/` that codifies the refactor review into a
repeatable CI/CD tool. Uses Acorn AST for 100% accurate import /
definition extraction (no false positives from `function esc` inside
comments or strings). Acorn is the one carve-out from the project's
no-frameworks rule, allowed in `tools/*` static-analysis scripts.

Supersedes the one-shot review in
[`docs/internal/archive/js-refactor-review.md`](../../../archive/js-refactor-review.md).

## Public surface

- Scans `frontend/scripts/**/*.js`.
- Views: files + LOC, unreachable modules, duplicate symbol definitions, import graph cycles.
- Emits `report.html` + `audit.json` (ingest-compatible).
- Auto-discovered as `js`.

## Drift-prone areas

- **Acorn dependency** version-pinned in `tools/package.json`; AST shape changes between Acorn versions can break parsers.
- **Entry-point set** for reachability analysis (main.js + service-worker.js) is hard-coded; new entry kinds need adding.
- **Duplicate-symbol detection** matches by name; module-strict-mode collisions are caught at parse-time as SyntaxErrors, not by this audit.

## Related

- [Audit-suite landing](index.md)
- [Archive: js-refactor-review](../../../archive/js-refactor-review.md) — the seed
- [Master runner: audit.sh](../shell/audit.md)
