---
title: tools/admin-scope-audit/audit.js
source: ../../../../../tools/admin-scope-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-06-08
---

# admin-scope-audit

## Purpose

User-surface `/admin/*` leak gate. A user-facing page (or any module it imports)
that calls a platform-admin endpoint is a bug: `/admin/*` routes are gated by
`require_platform_admin_mw` and return **all rows**, so a non-admin user gets
403/empty and an admin sees the whole platform instead of their own RBAC reach.
This is the frontend half of the admin-scope bug class (Lane 1, 2026-06-08); the
backend half — list queries that filter direct-owner-only instead of cascade
reach — is enumerated by [list-endpoint-rbac-audit](list-endpoint-rbac-audit.md).

Structural-detector pattern ([[build-for-unknown-failures]]): make the rule a
gate so one finding becomes N and it can't regress.

## How it classifies

1. Parses `main.js` `ROUTES` → which page entry-scripts are `admin: true`
   (today: `/monitoring`, `/admin-console`, `/database`). Everything else is a
   user surface.
2. Builds the **import graph** from every entry (static `import`, re-export, and
   dynamic `import()` of `/scripts/*` + relative specifiers). A module is
   *user-reachable* if any non-admin page can reach it — so a shared module
   (`framework/editor-entity-picker.js`) counts as a user surface the moment a
   user page imports it. This is why attribution is precise: e.g. `charts/
   home-bank.js` is flagged under `/settings` (it's imported by the settings
   chart-customizer `prefs/controls/chart-layouts.js`), not `/home`.
3. Scans every `.js` under `frontend/scripts` for `/admin/...` in **string /
   template literals** (AST-precise via Acorn — comments and identifiers can't
   trip it; Acorn is the `tools/` static-analysis carve-out,
   [[feedback-acorn-allowed-for-static-analysis]]).
4. A `/admin/*` literal in a user-reachable module ⇒ **leak (exit 1)** unless
   listed in `ALLOW{}` with a reason (a conscious exception — e.g. config
   metadata that isn't per-user data).

Buckets reported: **leaks** (gate), **ok** (admin-app surface or allowlisted),
**info/unreachable** (literal in a module no route statically reaches — e.g.
`framework/type-registry.js` `/admin/types`, which has zero static importers).

## Output

- Console report grouped into the three buckets; exit 1 on any leak.
- `audit.json` — machine-readable worklist (`findings`/`okAdmin`/`unreachable`),
  not ingested (no `audit.run` schema row needed).
- Auto-discovered by `tools/audit.sh` via the `tools/*-audit/` glob — no wiring.
  It will fail `audit.sh` until the Lane 1 repoint lands (expected during the sweep).

## The fix it drives

Repoint the user surface to the user-scoped, RBAC-reach endpoint (`/admin/charts`
→ `/charts`, `/admin/users?q=` → `/users?q=`, …). `/admin/*` stays for the Admin
app. Genuine admin EDIT affordances (e.g. platform-role PATCH) stay gated behind
`requiresAdmin`, not removed. Runbook: the admin-scope sweep.

## Drift-prone areas

- **Import-graph completeness drives correctness.** A missed edge = a false
  negative (a real leak mis-bucketed as unreachable). Resolution mirrors the
  browser: `/scripts/*` app-absolute + `./`/`../` relative; bare specifiers are
  external and skipped. A new import style (import maps, aliases) needs teaching.
- **String-built endpoints** are caught when `/admin/` is a literal prefix
  (`"/admin/users?q=" + x`). A fully computed path (`"/admin/" + kind`) would be
  missed — none exist today; keep endpoints literal-prefixed.

## Related

- [list-endpoint-rbac-audit](list-endpoint-rbac-audit.md) — backend list-scope reach.
- [auth-audit](auth-audit.md) · [api-doc-audit](api-doc-audit.md) — the /api seam.
