---
title: tools/ui-doc-audit/audit.js
source: ../../../../../tools/ui-doc-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-06-04
---

# ui-doc-audit

## Purpose

The UI-documentation **completeness gate** + dedup/divergence detector.
Auto-discovered by `tools/audit.sh` as tool `ui-doc`.

Em's requirement: completeness must be *guaranteed, not curated*. The denominator
is enumerated from code by [fe-inventory](../lib/fe-inventory.md), and this audit
**fails (exit 1)** if any enumerated component is missing from the generated catalog
index — so the day a component lands without being documented, CI goes red. Same
discipline as `doc-coverage-audit` (source files) and `api-doc-audit` (routes).
UI = backend.

## Public surface

`node tools/ui-doc-audit/audit.js` → console summary + `audit.json` + `audit.html`.
Exit 1 iff there are **coverage** findings.

## How it works

- **Coverage (HARD gate):** reads `docs/internal/ui/catalog/index.md` and checks every
  enumerated component key is listed in its `doc-gen:component:index` region. The index
  is *generated* by `tools/doc-gen --components`, so it is complete by construction —
  the gate is green on generation and red only when the index **drifts** from the code
  (a component added without regenerating). No baseline machinery: a generated,
  always-complete index means existing debt never wedges the shared suite.
- **Divergence (advisory):** `fe-inventory.divergences()` — one class styled under ≥2
  ancestor contexts → unify behavior.
- **Parallel (advisory):** `fe-inventory.parallels()` — a structural-role suffix shared
  across blocks (`-head`, `-title`, `-body`…) → compose one atom.
  Advisory findings are work-items (route to the FE-framework case); only coverage
  gates CI, so day-1 dedup debt doesn't block anyone.

## Drift-prone areas

- The gate keys on the index path `docs/internal/ui/catalog/index.md` and the
  `doc-gen:component:index` marker — keep in sync with `tools/doc-gen` (kind=component).
- Coverage is **token-presence** in the index (the component key appears). When the
  catalog explodes into per-component docs, tighten to per-file existence + region.
- `audit.json` / `audit.html` are regenerated each run (gitignored); not ingested
  (tool `ui-doc` is not in `audit.sh`'s `INGEST_TOOLS`).

## Related

- [fe-inventory](../lib/fe-inventory.md) — the enumerator + dedup analysis it consumes.
- [tools/doc-gen/gen.md](../doc-gen/gen.md) — generates the index this gate guards.
- The dedup findings feed the FE-framework convergence (CAS_9E4F134B).
