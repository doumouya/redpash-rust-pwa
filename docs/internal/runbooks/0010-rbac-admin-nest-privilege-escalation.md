---
title: RBAC — /admin nest ungated → privilege escalation + cross-tenant leaks
date: 2026-06-01
owner: Torv
area: backend/crates/api (RBAC / multi-tenancy)
severity: critical (security)
---

# 0010 — The `/admin` nest had no platform-admin gate (privilege escalation)

## Symptom

A full RBAC audit (`wf_f6c0350e`, 2026-06-01) found multi-tenancy enforcement
broken in **both** directions. The worst, live finding: **any authenticated
user could `POST /api/admin/memberships` and grant themselves `owner` of any
company / project / case / team** — full privilege escalation, which makes
every other RBAC check moot. The whole `/api/admin/*` family was
"dev-permissive" (no auth gate): `GET /admin/{users,companies,files,charts,
steps,teams,memberships}` leaked every tenant's data; `DELETE /admin/users`,
`/admin/companies`, `/admin/memberships` mutated any tenant's state.

Stakes (Em): cross-tenant data exposure / unauthorized edits = GDPR + contract
+ trust-destroying, potentially criminal. Treated as breach-prevention.

## Diagnosis

Root cause is an **asymmetry**, not 14 forgotten handler checks. The
`/monitoring` route-nest (`routes/mod.rs:243-244`) carries a
`require_platform_admin_mw` **layer** that 404s non-admins before any handler.
The `/admin` nest (`mod.rs:245`) **had no such layer** — and
`require_platform_admin_mw`'s own doc says it was meant to cover "the Admin
Console group." So the per-handler `is_platform_admin` checks that *do* exist
in `admin.rs` (`list_fields`, `put_field`, …) were the exception; the
membership/user/company endpoints simply never got one.

`is_platform_admin` (`rbac.rs:221`) = `caller == dev_user` OR
`users.role = 'admin'` — so the layer admits platform admins and 404s everyone
else, fail-closed.

## Fix (this commit — Phase 0 of the RBAC epic)

`routes/mod.rs`: add the `require_platform_admin_mw` layer to the `/admin`
nest, mirroring `/monitoring`. One layer closes the entire escalation +
admin-leak set (audit groups B3-B10, C1-C4). 404-on-deny keeps the leak-free
contract. Safe: the FE Admin Console is already `is_platform_admin`-gated, so
no legitimate non-admin flow hits `/api/admin/*` (org-admin self-service
management lands later via reach-scoped `/:rid/members`, not this surface).

Verification (this commit): `cargo check -p api` green; gate correctness
confirmed by reading `is_platform_admin`. **A behavioral regression test
(`M(A) POST /api/admin/memberships → 404`, platform-admin → 200) lands with the
RBAC test harness — Phase A/E of the epic.** Deploy is gated on a backend
restart of `:8080`.

## The bigger picture (epic, plan-approved)

This is only Phase 0. The audit found two more classes: `ensure_owner`
(`mod.rs:71-85`, strict personal-owner) bypasses the `resolve_grant` resolver
→ 404s company-admins + platform-admins on ~12 endpoints; and tenant-isolation
leaks in `list_companies` / `list_events` / `search.rs` / `list_charts` /
`list_dashboards`. Full plan + the five pillars (Enforce · Manage · Admin
Console · Impersonate · Test) in the approved plan file. Prevention: the
regression-gated `rbac_matrix` suite + RLS as the structural wall.

## Prevention

- `tests/rbac_matrix.rs` (forthcoming) — every actor × resource × action →
  expected status; wired into `tools/audit.sh` so RBAC drift fails the gate.
- RLS (Postgres row-level security) — the unforgettable wall, so a future
  forgotten check can't leak.
