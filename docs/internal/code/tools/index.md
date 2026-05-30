---
title: Internal · Code · Tools — atomic docs for tools/
section: Internal · Code · Tools
order: 3
last modified date: 2026-05-30
---

# Tools — atomic docs

One doc per **unit** under `tools/`. A "unit" here is **not** strictly
per-file — the granularity depends on the tool's shape:

| Category | Unit | Mapping |
|---|---|---|
| Audit family (`tools/<name>-audit/`) | one doc per audit | → [`audit-suite/<name>-audit.md`](audit-suite/) |
| Shell scripts (`tools/<name>.sh`) | one doc per script | → [`shell/<name>.md`](shell/) |
| Per-dir tools | one doc per dir, regardless of internal file count | → `tools/<name>.md` |
| One-off cluster | one doc per dir | → [`one-off/<name>.md`](one-off/) |

**Coverage at baseline (2026-05-30):** 32 atomic units, 0 documented.
Phase D (per the [plan](../../processes/atomic-doc-plan.md)) walks
this up — audit-suite docs are largely **extractable** from the rich
existing headers in each `audit.js`, so they're the cheapest pillar to
fill.

## Audit family — `audit-suite/` (15 units)

- [`auth-audit.md`](audit-suite/) — backend route auth-posture audit
- [`ci-audit.md`](audit-suite/)
- [`crossing-audit.md`](audit-suite/) — JS ↔ Rust `/api` seam
- [`css-audit.md`](audit-suite/) — CSS conflicts / duplication
- [`css-cross-page-audit.md`](audit-suite/) — page-prefixed class leaks
- [`css-tab-compare-audit.md`](audit-suite/)
- [`html-audit.md`](audit-suite/)
- [`js-audit.md`](audit-suite/) — frontend JS LOC, dups, unreachable modules
- [`observability-audit.md`](audit-suite/) — the meta-audit (watches the observability stack)
- [`page-structure-audit.md`](audit-suite/)
- [`redtable-audit.md`](audit-suite/)
- [`rs-audit.md`](audit-suite/) — backend Rust structural / refactoring health
- [`rs-perf-audit.md`](audit-suite/) — backend Rust perf candidates (Em 2026-05-29)
- [`ui-snapshot-audit.md`](audit-suite/)
- [`doc-coverage-audit.md`](audit-suite/) — this audit (the one that enforces the atomic-doc plan)

## Shell scripts — `shell/` (9 units)

- [`audit.md`](shell/) — `tools/audit.sh`, the master runner: auto-discovers every `tools/*-audit/audit.js`
- [`build-wasm.md`](shell/) — `tools/build-wasm.sh`
- [`db-reset.md`](shell/), [`db-setup.md`](shell/)
- [`dev-setup.md`](shell/), [`health-check.md`](shell/), [`install-stack.md`](shell/)
- [`port-check.md`](shell/), [`stack-version.md`](shell/)

## Per-dir tools (5 units)

- [`mcp-server.md`](mcp-server.md) — MCP HTTP/SSE server, exposes cases + slack to other agents
- [`team.md`](team.md) — team-coordination harness: presence files, post-commit hooks, board overlay
- [`wasm-bench.md`](wasm-bench.md) — WASM benchmark harness (the per-file profile data on the login demo will use this; see `project_landing_csv_demo`)
- [`memory-gc.md`](memory-gc.md) — auto-memory cleanup utility
- [`parse-diag.md`](parse-diag.md) — CSV parse diagnostic / rescue debugger

## One-off cluster — `one-off/` (3 units)

- [`css-parallel.md`](one-off/) — parallel-CSS analyzer (extracted from css-audit)
- [`css-usage.md`](one-off/)
- [`csv-to-xlsx-rs.md`](one-off/) — Rust-native CSV→XLSX converter

## Reading order for new contributors

1. [`shell/audit.md`](shell/) — what runs when you type `sh tools/audit.sh`
2. [`audit-suite/css-audit.md`](audit-suite/) — most mature audit, sets the shape
3. [`audit-suite/rs-perf-audit.md`](audit-suite/) — newest audit (the shape new ones should follow)
4. [`audit-suite/doc-coverage-audit.md`](audit-suite/) — the audit that enforces this whole tree

## Related

- [Audit-storage spec](../../specs/audit-storage-design.md) — was `tools/audit-storage-brainstorming.md` (Phase A `git mv` per plan §10·4)
- [Public REDMAP — tools section](../../../../REDMAP.md)
