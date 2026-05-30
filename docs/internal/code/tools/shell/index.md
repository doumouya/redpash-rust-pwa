---
title: Internal · Code · Tools · shell — atomic docs
section: Internal · Code · Tools · shell
order: 22
last modified date: 2026-05-30
---

# tools/*.sh — atomic docs

Shell scripts that run setup, builds, health checks, and the master
audit runner. None of these are auto-discovered — they're invoked by
hand or from CI / make targets.

**Coverage at baseline (2026-05-30):** 9 atomic units, 0 documented.

## Scripts

| Script | Atomic doc | Role |
|---|---|---|
| `audit.sh` | [audit.md](audit.md) | **the master runner** — auto-discovers every `tools/*-audit/audit.js`, ingests `audit.json` outputs, prints diff-since-last-run |
| `build-wasm.sh` | [build-wasm.md](build-wasm.md) | builds the `data` crate to WASM (the bundle the login demo loads) |
| `db-reset.sh` | [db-reset.md](db-reset.md) | drops + recreates the dev DB |
| `db-setup.sh` | [db-setup.md](db-setup.md) | creates the dev DB + runs `sqlx migrate run` |
| `dev-setup.sh` | [dev-setup.md](dev-setup.md) | first-run dev bootstrap (DB + env + cargo build) |
| `health-check.sh` | [health-check.md](health-check.md) | hits `/api/health` and checks DB connectivity |
| `install-stack.sh` | [install-stack.md](install-stack.md) | installs the runtime stack (Rust toolchain, Postgres, Node) |
| `port-check.sh` | [port-check.md](port-check.md) | verifies the dev port is free before `cargo run` |
| `stack-version.sh` | [stack-version.md](stack-version.md) | prints versions of every runtime + dependency (precursor to the dep-audit tool) |

## Related

- [Tools pillar landing](../index.md)
- [Spec: dep-audit-design](../../../specs/dep-audit-design.md) — `stack-version.sh` is the seed for the dep-audit work
- [Process: audit-cadence](../../../processes/audit-cadence.md)
