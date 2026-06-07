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

- Scans `backend/crates/**/*.rs`, `frontend/scripts/**/*.js`, `tools/*-audit/audit.js`, `tools/**/*.sh`, the per-dir-single + one-off tool clusters, AND (dynamically) the remaining tool dirs **per-file** (`tools/<dir>/*.js` → `code/tools/<dir>/<file>.md`, e.g. doc-gen, lib, page-verify, css-twin-verify; spike/output dirs excluded).
- Emits `report.html` (per-pillar coverage % + finding rows) and `audit.json` (ingest-compatible).
- Auto-discovered by `tools/audit.sh` via the `tools/*-audit/` glob — tool name resolves to `doc-coverage`.
- Uses `execFileSync` (not `exec`) for `git log -1 --format=%ct` calls so paths with shell metacharacters can't inject.

## Drift-prone areas

- **Source → doc mapping** drops `crates/` and `src/` from backend paths and has per-category rules for `tools/` (audit-family → `audit-suite/`, shell → `shell/`, per-dir-single, one-off, and the dynamic per-file branch for the rest). A new per-file tool dir is picked up automatically; a new *spike/output* dir must be added to the skip set (`opfs-spike`, `out`, `screens`).
- **`unindexed_internal_doc`** is satisfied three ways: a path-substring in `redmap.md`; for `code/` survival docs, appearing in the generated `code/_nav.md` back-index (`doc-gen --code-nav`); or being listed by basename in the doc's **own section `index.md`** (every spine section — pages/, db/schemas/, rest-api/, … — is its own nav, so the structure self-indexes instead of duplicating a catalog into redmap). Replaced the old redmap-substring-only check that over-counted every code doc.
- **`missing_breadcrumb`** scans the first 30 lines for a `Doc:` prefix after stripping a leading comment marker *and/or* leading whitespace — so an indented `Doc:` on a multi-line-comment continuation line (the dominant JS style) is matched. (The old single-regex required a marker immediately before `Doc:` and false-flagged ~35 compliant files.)
- **`stub_doc`** can be opted out per-doc with `concise: true` in the YAML front-matter (a genuinely small unit whose required sections are correctly brief) — keeps the signal meaningful vs lowering the threshold. **`stale_doc`** threshold is 14 days (decision §10·2).
- **CSS docs** (`code/frontend/styles/`) are exempt from `orphan_doc` — CSS has no per-file source-enumeration rule (touch-policy scopes to `tools/` + `frontend/scripts/` + `backend/crates/`).

## 9 finding kinds

`missing_doc` · `missing_breadcrumb` · `wrong_breadcrumb` · `stub_doc` ·
`stale_doc` · `orphan_doc` · `missing_required_heading` ·
`unregistered_section` · `unindexed_internal_doc`.

## Related

- [Audit-suite landing](index.md)
- [Plan: atomic-doc-plan](../../../processes/atomic-doc-plan.md)
- [Master runner: audit.sh](../shell/audit.md)
