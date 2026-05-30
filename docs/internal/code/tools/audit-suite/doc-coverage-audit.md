---
title: tools/doc-coverage-audit/audit.js
source: ../../../../../tools/doc-coverage-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-05-30
---

# doc-coverage-audit

## Purpose

Enforces the atomic-doc discipline. Every source file under `tools/`,
`frontend/scripts/`, and `backend/crates/` is expected to have a
corresponding atomic doc under `docs/internal/code/<mirrored-path>.md`
AND a 2-line `Doc:` breadcrumb in the source pointing back at it; this
tool walks the codebase and reports drift in either direction. Also
enforces *navigational* consistency: every dir under `docs/internal/`
must be a row in the shape-ontology table, and every doc under
`docs/internal/` should be cross-linked from `internal/redmap.md`.

Shipped 2026-05-30 as Phase A.1 of the [atomic-doc plan](../../../processes/atomic-doc-plan.md).

## Public surface

- Scans `backend/crates/**/*.rs`, `frontend/scripts/**/*.js`, `tools/**/audit.js`, `tools/**/*.sh`, plus the 3 one-off tool dirs.
- Emits `report.html` (per-pillar coverage % + finding rows) and `audit.json` (ingest-compatible).
- Auto-discovered by `tools/audit.sh` via the `tools/*-audit/` glob — tool name resolves to `doc-coverage`.
- Uses `execFileSync` (not `exec`) for `git log -1 --format=%ct` calls so paths with shell metacharacters can't inject.

## Drift-prone areas

- **Source → doc mapping** drops `crates/` and `src/` from backend paths and has per-category rules for `tools/` (audit-family vs shell vs per-dir vs one-off). Any new tool category needs an enumerator branch.
- **`unindexed_internal_doc` heuristic** does a substring check for `<dir>/<file>` in `redmap.md`; the internal redmap's ASCII-tree convention writes basenames, so this metric over-counts. Known false-positive; refine when load-bearing.
- **`stale_doc` threshold** is 14 days (decision §10·2). Bump in the rule if the cadence changes.

## 9 finding kinds

`missing_doc` · `missing_breadcrumb` · `wrong_breadcrumb` · `stub_doc` ·
`stale_doc` · `orphan_doc` · `missing_required_heading` ·
`unregistered_section` · `unindexed_internal_doc`.

## Related

- [Audit-suite landing](index.md)
- [Plan: atomic-doc-plan](../../../processes/atomic-doc-plan.md)
- [Master runner: audit.sh](../shell/audit.md)
