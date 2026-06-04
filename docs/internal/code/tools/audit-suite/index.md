---
title: Internal · Code · Tools · audit-suite — atomic docs
section: Internal · Code · Tools · audit-suite
order: 21
last modified date: 2026-05-30
---

# tools/*-audit — atomic docs

One doc per `tools/<name>-audit/` directory. Each is a Node.js scanner
(ES5 CommonJS, no deps) that walks one slice of the codebase and emits
`report.html` + (when ingest-wired) `audit.json`. Auto-discovered by
`tools/audit.sh`'s `tools/*-audit/` glob — a new audit dir is picked up
without editing the runner.

**Coverage at baseline (2026-05-30):** 15 atomic units, 0 documented.

## Audits

| Audit dir | Atomic doc | What it scans |
|---|---|---|
| `auth-audit/` | [auth-audit.md](auth-audit.md) | backend route auth-posture audit — every handler has an explicit auth check or is explicitly `public:` |
| `ci-audit/` | [ci-audit.md](ci-audit.md) | CI config drift |
| `class-count-audit/` | [class-count-audit.md](class-count-audit.md) | the coherence burndown — ≤1 framework class + 1 id per atom (multi-class stacks + legacy state classes) |
| `crossing-audit/` | [crossing-audit.md](crossing-audit.md) | the JS ↔ Rust `/api` seam — crossings / dangling / unused |
| `css-audit/` | [css-audit.md](css-audit.md) | CSS conflicts, duplicate decl blocks, duplicate selectors |
| `css-cross-page-audit/` | [css-cross-page-audit.md](css-cross-page-audit.md) | page-prefixed CSS class leaks across pages |
| `css-tab-compare-audit/` | [css-tab-compare-audit.md](css-tab-compare-audit.md) | per-tab CSS comparison |
| `doc-coverage-audit/` | [doc-coverage-audit.md](doc-coverage-audit.md) | this section's enforcer — atomic doc coverage + drift |
| `html-audit/` | [html-audit.md](html-audit.md) | HTML structure / duplication |
| `js-audit/` | [js-audit.md](js-audit.md) | frontend JS — LOC, unreachable modules, duplicate symbols |
| `observability-audit/` | [observability-audit.md](observability-audit.md) | the meta-audit — watches the observability stack itself |
| `page-structure-audit/` | [page-structure-audit.md](page-structure-audit.md) | per-page shell-pattern consistency |
| `redtable-audit/` | [redtable-audit.md](redtable-audit.md) | redtable atom consistency across consumers |
| `rs-audit/` | [rs-audit.md](rs-audit.md) | backend Rust — structural / refactoring health (LOC, repeated lines, big match blocks, named anti-patterns) |
| `rs-perf-audit/` | [rs-perf-audit.md](rs-perf-audit.md) | backend Rust — perf candidates (collect-then-slice, cache evict+rehydrate, n+1, etc.) |
| `ui-doc-audit/` | [ui-doc-audit.md](ui-doc-audit.md) | UI doc **completeness gate** (every enumerated component is in the catalog) + dedup/divergence detector |
| `ui-snapshot-audit/` | [ui-snapshot-audit.md](ui-snapshot-audit.md) | UI snapshot diff |

## Reading order

1. [css-audit.md](css-audit.md) — most mature audit, sets the shape every other one follows.
2. [rs-perf-audit.md](rs-perf-audit.md) — newest (2026-05-29), reflects the current convention.
3. [doc-coverage-audit.md](doc-coverage-audit.md) — the enforcer of this whole tree.
4. The master runner is [`../shell/audit.md`](../shell/audit.md) (`tools/audit.sh`).

## Related

- [Tools pillar landing](../index.md)
- [Subsystem: audit-storage](../../../subsystems/audit-storage.md)
- [Process: audit-cadence](../../../processes/audit-cadence.md)
- [Spec: audit-storage-design](../../../specs/audit-storage-design.md)
- [Spec: audit-ingest-explode](../../../specs/audit-ingest-explode.md)
