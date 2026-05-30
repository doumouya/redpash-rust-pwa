---
title: tools/rs-perf-audit/audit.js
source: ../../../../../tools/rs-perf-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-05-30
---

# rs-perf-audit

## Purpose

Sibling of [`rs-audit`](rs-audit.md) (structural / refactoring health).
This one scans for known performance anti-patterns that cost real CPU
or allocations on the request path. The rule set was seeded by the
2026-05-29 backend perf audit — the 7 candidates that came out of that
pass are encoded here as live checks, so the moment one regresses (or a
new instance shows up in a future PR) the audit surfaces it.

## Public surface

- 8 detection rules (current backend hit counts in parentheses):
  - `polars-collect-then-slice` (high · 3)
  - `cache-evict-then-rehydrate` (high · 2)
  - `double-clone-value` (high · 0 — known regex limit)
  - `json-string-roundtrip` (medium · 4)
  - `hardcoded-small-pool` (medium · 3)
  - `unbounded-delete-cleanup` (medium · 1)
  - `blocking-io-in-async` (low · 12)
  - `n-plus-one-sqlx` (high · 1 — bonus)
- Inline opt-out: `// rs-perf-allow: <rule-id>` within 3 lines of the flagged site.
- Emits `report.html` + `audit.json`; auto-discovered as `rs-perf`.

## Drift-prone areas

- **Heuristic, not AST.** `double-clone-value` matches identifier names not data flow, so the seeded `s.params.clone()` + `v.clone()` case is missed (different identifier names). Refining needs scope analysis or `syn`.
- **`blocking-io-in-async`** flags every `std::fs::*` in any file with `async fn` — broad; many hits are helpers off the request path. Refine by scoping to handler-reachable code.
- **Severity thresholds** (e.g. `hardcoded-small-pool` at `N ≤ 16`) live inline in each rule body. Project-policy knobs.

## Related

- [Audit-suite landing](index.md)
- [Sibling: rs-audit](rs-audit.md)
- [Master runner: audit.sh](../shell/audit.md)
- Original perf audit (2026-05-29) — findings encoded as this audit's rule set
