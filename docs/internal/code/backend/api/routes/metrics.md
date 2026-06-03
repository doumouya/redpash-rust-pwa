---
title: backend/crates/api/src/routes/metrics.rs
source: ../../../../../../backend/crates/api/src/routes/metrics.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-06-03
---

# metrics.rs

## Purpose

`/api/metrics` — performance read surface over `request_log`.

GET /api/metrics?window=1h|24h|7d|30d   (default 1h)

**Platform-admin-only** (2026-06-03): the `/metrics` nest is gated by
`require_platform_admin_mw` in [mod.rs](mod.md) (mirrors `/monitoring`) — non-admins get a
leak-free 404 before the handler. `request_log` is tenant-less (no company column), so this
is global system observability; per-company metrics would need a `request_log.company_id`
(future). Was anonymously readable before the gate —
[runbook](../../../../runbooks/CAS_CBA057EE46F24BAD897089D2B9DDBDFC-metrics-anon-leak.md).

## Public surface

- `pub fn routes` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
