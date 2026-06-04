---
title: tools/crossing-audit/audit.js
source: ../../../../../tools/crossing-audit/audit.js
owner: Gus
section: Internal · Code · Tools · audit-suite
last modified date: 2026-06-03
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
- Emits `report.html`.
- Auto-discovered as `crossing`.
- The **Rust route set** now comes from the shared
  [`tools/lib/rust-routes.js`](../lib/rust-routes.md) extractor (migrated
  2026-06-03), so it covers `routes/files/*` and the `/:rid/members` nests its
  old private extractor silently skipped. `norm()` is shared from the same lib.

## Drift-prone areas

- **Path normalisation** lives in the shared lib now (`norm()`); new path
  segment kinds are added there, for every consumer at once.
- **`api.get` / `api.post` / `api.patch` / `api.del`** are the recognised JS call sites; alternative shapes (raw `fetch`, helper wrappers) would slip past.
- The audit doesn't yet do the DTO half — that's the other crossing kind, deferred.

## Related

- [Shared extractor: rust-routes](../lib/rust-routes.md)
- [Audit-suite landing](index.md)
- [Architecture: js-rust-boundary](../../../architecture/js-rust-boundary.md)
- [Subsystem: api-routes](../../../subsystems/api-routes.md)
- [Master runner: audit.sh](../shell/audit.md)
