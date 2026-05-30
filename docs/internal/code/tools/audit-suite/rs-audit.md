---
title: tools/rs-audit/audit.js
source: ../../../../../tools/rs-audit/audit.js
owner: Gus
section: Internal · Code · Tools · audit-suite
last modified date: 2026-05-30
---

# rs-audit

## Purpose

Backend Rust structural / refactoring health. A static scan of
`backend/` that codifies Gus's manual Rust audit into a repeatable
tool — re-run it as the refactor lands to watch the mass come down.
Originally seeded from
[`docs/internal/archive/rust-dedup-audit-2026-05-24.md`](../../../archive/rust-dedup-audit-2026-05-24.md)
and [`suggestion-rust-factorisation.md`](../../../archive/suggestion-rust-factorisation.md).

## Public surface

- Four views:
  - **Files** — every `.rs` file with crate + LOC; flags hotspots (LOC > 600).
  - **Repeated lines** — substantial source lines recurring ≥ 4×.
  - **Big matches** — `match` blocks over 60 lines.
  - **Patterns** — named anti-patterns from the dedup-audit doc (status: extracted / live / declined).
- Emits `report.html` + (ingest-wired) `audit.json`. Auto-discovered as `rs`.

## Drift-prone areas

- **Heuristic, not parser** — regex + brace counting. Framework boilerplate (Axum extractor signatures) recurs by design and shows up too; a candidate list, not a verdict.
- **Pattern catalog** in the source needs hand-curation when a new anti-pattern joins. Statuses (`extracted` / `declined` / `live`) are project-policy.
- **LOC thresholds** (`BIG_LOC = 600`, `BIG_MATCH = 60`, `DUP_MIN = 4`) live inline. Tunable per cleanliness-cadence call.

## Related

- [Audit-suite landing](index.md)
- [Sibling: rs-perf-audit](rs-perf-audit.md) — runtime perf candidates
- [Archive: rust-dedup-audit](../../../archive/rust-dedup-audit-2026-05-24.md) — the seed
- [Master runner: audit.sh](../shell/audit.md)
