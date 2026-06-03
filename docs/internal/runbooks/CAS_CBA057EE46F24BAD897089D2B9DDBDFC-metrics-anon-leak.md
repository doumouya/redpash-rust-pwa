---
title: "GET /api/metrics anonymously exposed the global request_log"
order: 14
case_id: CAS_CBA057EE46F24BAD897089D2B9DDBDFC
section: Internal
severity: Sev1
last modified date: 2026-06-03
owner: Torv
---

# 0014 — `/api/metrics` was anonymously readable

## Problem Statement

`GET /api/metrics` returned platform-wide operational telemetry — total request count,
error rate, p50/p95/p99 latency, and a **full per-`(method, route)` inventory** — to **any
caller with no authentication at all**. A stranger could enumerate the entire API surface
and read the platform's operational posture. Surfaced by the "audit the auditor" RBAC
review (workflow `wf_afacef54`, 2026-06-03), which built independent ground-truth gating and
found this among 5 read-leaks the SQL-only audit had missed.

## Troubleshooting steps

1. Independent route-gating ground-truth (the workflow) flagged `/metrics` as an ungated
   nest exposing tenant-less global data — not a YELLOW "verify", a real leak.
2. Read `routes/metrics.rs`: handler `metrics(State, Query)` takes **no `HeaderMap`** and
   never calls `resolve_user_rid` — zero auth.
3. Read `routes/mod.rs`: `.nest("/metrics", metrics::routes())` carried **no `.layer()`**,
   unlike `/monitoring` + `/admin` (which wrap `require_platform_admin_mw`).
4. Read the `request_log` schema (mig `20260529000000`): no `company_id` column → tenant-less
   global ops data, so per-tenant scoping is impossible; only the platform should see it.
5. Confirmed `/api/metrics` is **orphaned** — the FE Monitoring page uses `/monitoring/requests*`
   (already platform-admin gated, same `request_log`), so nothing consumes `/api/metrics`.

## RCA

Two gaps, both invisible to a handler-only read: the handler did no auth **and** its nest had
no middleware. The data is global system-observability, so the correct model is
platform-admin-only. The audit missed it because `list-endpoint-rbac-audit` (v1) scanned only
`db/` SQL shape and `auth-audit` scanned only handler bodies — **neither parsed `mod.rs` nest
`.layer()` middleware**, so an ungated tenant nest read as a YELLOW shrug rather than RED. (Same
blind spot that *false-positived* `/admin`'s `create_membership` as "ungated".)

## Solution

- **Gated the `/metrics` nest platform-admin-only** (`routes/mod.rs`): added
  `let metrics_admin_state = state.clone();` and wrapped the nest with
  `.layer(from_fn_with_state(metrics_admin_state, require_platform_admin_mw))` — the *same
  proven middleware* already on `/admin` + `/monitoring`. Non-admins now get a leak-free 404
  before the handler. No new auth code; no schema change.
- Corrected the stale `metrics.rs` header doc ("gate behind the company-admin role" →
  platform-admin). **Deferred:** per-company metrics would need a `request_log.company_id`
  column — not built; global ops data stays platform-only for now.
- **Prevention (regression guard):** added `'metrics'` to `EXPECT_NEST_GATE` in
  `tools/list-endpoint-rbac-audit/audit.js` (the v2 nest-aware pass, commit `b8c0202`). The
  audit now **asserts** `/metrics` is platform-admin-gated — GREEN today, **RED
  `nest-gate-missing`** the moment anyone removes the `.layer()`. Drift fails the tool.

## Post Checking

- `cargo build -p api` green.
- `node tools/list-endpoint-rbac-audit/audit.js` → `/metrics` GREEN under `EXPECT_NEST_GATE`
  (was YELLOW tenant-nest); no new RED introduced.
- The middleware is already runtime-proven on `/admin` (unauthenticated
  `GET /api/admin/memberships` → 404, confirmed on the live :8080 binary), so `/metrics`
  inherits that behaviour. The full non-admin→404 HTTP matrix lands in `tests/rbac_matrix.rs`
  (epic step 7), where `/metrics` is one row.
- **Watching:** 4 sibling read-leaks from the same review remain open — `/events`,
  `/companies` (product call pending), `/search`, `/teams`.
