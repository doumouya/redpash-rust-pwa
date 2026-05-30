---
title: tools/crossing-audit/audit.js
source: ../../../../../tools/crossing-audit/audit.js
owner: Gus
section: Internal · Code · Tools · audit-suite
last modified date: 2026-05-30
---

# crossing-audit

## Purpose

The JS ↔ Rust API seam audit. The [js-rust-boundary](../../../architecture/js-rust-boundary.md)
contract: the two languages may cross at exactly two points — HTTP
`/api` routes and shared-crate DTOs. This tool does the route half:
joins the `/api` paths the JS calls against the routes the Rust
serves, the way [`css-audit`](css-audit.md) joins a class to the rules
that target it.

## Public surface

- Three views:
  - **Crossings** — an `/api` path the JS calls AND the Rust serves. Healthy.
  - **Dangling** — JS calls a path the Rust doesn't serve. **Bug.**
  - **Unused** — Rust serves a path no JS calls. May be admin / curl / future.
- Emits `report.html` + `audit.json` (ingest-compatible).
- Auto-discovered as `crossing`.

## Drift-prone areas

- **Path normalisation** must collapse `:rid` ↔ `:id` and similar; new path segment kinds need adding.
- **`api.get` / `api.post` / `api.patch` / `api.del`** are the recognised JS call sites; alternative shapes (raw `fetch`, helper wrappers) would slip past.
- The audit doesn't yet do the DTO half — that's the other crossing kind, deferred.

## Related

- [Audit-suite landing](index.md)
- [Architecture: js-rust-boundary](../../../architecture/js-rust-boundary.md)
- [Subsystem: api-routes](../../../subsystems/api-routes.md)
- [Master runner: audit.sh](../shell/audit.md)
