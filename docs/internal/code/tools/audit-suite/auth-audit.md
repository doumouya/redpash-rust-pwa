---
title: tools/auth-audit/audit.js
source: ../../../../../tools/auth-audit/audit.js
owner: Gus
section: Internal · Code · Tools · audit-suite
last modified date: 2026-05-30
---

# auth-audit

## Purpose

Ownership-hygiene scanner — Em-greenlit RBAC prep (2026-05-24): *a
mechanical regression net for ownership hygiene BEFORE the RBAC
workstream lands. RBAC on a leaky surface = leaky RBAC.* Walks every
backend route handler and, for each handler that path-extracts a
resource id, checks that an ownership gate appears before any `db::*`
mutation OR `Json(...)` return. For mutation handlers, checks that
`event::record` fires for the audit trail.

## Public surface

- Scans `backend/crates/api/src/routes/**/*.rs`.
- Emits `report.html` + `audit.json` (ingest-compatible).
- Auto-discovered as `auth`.
- Inline opt-out: `// AUTH-AUDIT-ACK: <reason>` on the handler (applies to every category — ownership, scope-parent, audit-trail). The annotation text is captured into the report so reviewers see *why* a gate was skipped.
- **Cat-4 — unchecked `scope_parent_id` / parent binds** (CAS_26EC04CAF5934A0996B7A04C8FA55534, sibling of CAS_DD6F): flags a handler that reads a caller-supplied `scope_parent_id` / `…parent_id` from the request body, binds it into an INSERT/UPDATE (or a `db::*_`/`register_entity` mutation), AND has **no reach gate** (`require_grant` / `require_view` / `require_action`) and no ACK. The three classifiers — `readsScopeParent(params, body)`, `bindsParentToWrite(body)`, `callsReachGate(body)` — plus `hasAuthAck(rawBody)` are `module.exports`-ed (the body is gated by `if (require.main === module)` so `node audit.js` still runs standalone). Emits a `scopeParentLeaks` array + `stats.scopeParentLeaks` headline + its own card/tab/panel; ACK'd hits route to a `scopeParentAck` bucket (parity with `acknowledged`). v1 field-name set is narrow on purpose (`/\b(scope_parent|parent)_id\b/` only) to stay at zero false positives — `project_id`/`owner_id`/`source_file_id` are deliberately out. `objects.rs::create` is the primary green case (guarded by `require_grant`).

## Drift-prone areas

- **Detection of "ownership gate"** (Cat-1) keys on `ensure_owner` / `*_owner` / `require_member` helpers. A new ownership-check pattern needs adding to the recognised set. NB: Cat-1's `callsOwnershipGate` does **not** know `require_grant` — so it still reports `objects.rs::create` as a `no-ensure-owner` false positive. That is a known, separate Cat-1 gap; Cat-4's `callsReachGate` is deliberately a distinct gate set.
- **Cat-4 reach-gate set** (`callsReachGate`) is kept SEPARATE from Cat-1's `callsOwnershipGate` on purpose: `require_grant`/`require_view`/`require_action` only. Merging the two sets would lose the precision that makes `objects.rs::create` a Cat-1 false positive but a Cat-4 non-finding. A new RBAC reach primitive needs adding to `callsReachGate`.
- **Cat-4 v1 field set is narrow** (`scope_parent_id` / `…parent_id`). Broaden to other `*_id` body fields only in response to a finding — starting broad floods the report with legitimately-guarded binds (`project_id`, `owner_id`).
- **`bindsParentToWrite` is regex over the body** — an INSERT/UPDATE built through a query-builder helper, or a bind reached via an intermediate variable, can slip past. Read the code to confirm a hit, like the rest of the heuristic.
- **`event::record` detection** is regex over the handler body; obfuscated through a helper fn would slip past.
- The audit prerequires the RBAC workstream's vocabulary; will need a refresh after Phase RBAC lands.

## Related

- [Audit-suite landing](index.md)
- [Subsystem: api-routes](../../../subsystems/api-routes.md)
- [Master runner: audit.sh](../shell/audit.md)
