---
case_id: pending
filename_pending_rename: true
title: objects.rs create — cross-tenant scope_parent_id IDOR
area: backend/api/routes/objects.rs
date: 2026-06-08
severity: medium
---

# objects.rs create — cross-tenant `scope_parent_id` IDOR

## Problem statement
An automated background security review flagged a MEDIUM Authorization (IDOR / scope-injection)
issue in `backend/crates/api/src/routes/objects.rs` `create` (POST `/api/objects/:type`):
`body.scope_parent_id` is caller-supplied and was bound straight into the `entity_data` INSERT
with no authorization against the caller's reach to that parent scope.

## Verification (how we confirmed it before fixing)
A 5-agent adversarial workflow (3 readers → 2 verifiers) verified it against the real RBAC
model. Both verifiers returned **exploitable=true, high confidence**; the agent tasked with
*refuting* it reported "refutation fails" — no upstream guard, FK, RLS, or downstream re-check
protects the column.

## Root cause
- The `create` handler ran only `require_type` + `validate_fields` before the INSERT — **no
  RBAC check** on `scope_parent_id` (objects.rs ~line 105→117).
- The `/objects` route has **no auth middleware** (contrast `/admin` → `require_platform_admin_mw`),
  so any authenticated non-admin reaches it.
- `entity_data.scope_parent_id` is a nullable TEXT column with **no FK/CHECK/trigger/RLS**
  (`migrations/20260607000002_entity_data.sql:22`).
- The injected value is **live in RBAC**: the cascade arm `GRANT_SQL` (`rbac.rs:105`,
  `UNION SELECT scope_parent_id …`) and the list REACH clause (`objects.rs:288-290`,
  `m.object_redpash_id IN (ed.object_id, ed.scope_parent_id)`).

**Impact (precise):** *not* upward takeover — cascade flows parent→child, so the attacker gains
no access *into* the victim scope. The harm is cross-tenant **injection**: an attacker grafts an
attacker-owned object into a scope B they don't belong to; it then (a) surfaces to every B member
in their list results and (b) hands B's admins a cascade grant (incl. write/delete) over the
attacker's object. A cross-tenant visibility + integrity / data-pollution IDOR.

## Solution
Gate the parent before accepting it — when `body.scope_parent_id.is_some()`, require **≥Member**
reach on the parent, mirroring the established write-into-parent pattern in `connectors.rs:99-112`:

```rust
if let Some(parent) = body.scope_parent_id.as_deref() {
    let kind = state.type_cache.object_kind(parent);           // type_cache.rs:232 → &'static str
    crate::rbac::require_grant(&state, &caller, parent, kind,
        |g| g.effective().is_some_and(|r| r >= Role::Member)).await?;  // rbac.rs:246, leak-free 404
}
```

- **`require_grant` 404s leak-free** on no reach (rbac.rs) — an existing-but-foreign scope is
  indistinguishable from a missing one (no IDOR-by-error-message).
- **`object_kind` default-denies** an unknown id (resolves an empty grant → 404).
- **Platform-admin bypass** via `is_platform_admin` is intended.

**Tier decision (Em, 2026-06-08): Member+.** Not Viewer+ (attaching an object is a *write* into
the scope, so view-only members must not inject). Not Admin+ (creating content in a scope you
belong to is a normal Member action; Admin+ would lock legitimate members out of their own scope).

## Regression test spec (executable test deferred to the tester role)
No HTTP+DB+seeded-membership integration harness exists in `routes/` yet, so the executable test
is the **first dogfood job for the `tester` role** (it needs that harness, itself a small infra
task). Required cases (POST `/api/objects/<registered_type>`):

| Caller | `scope_parent_id` | Expect |
|---|---|---|
| Member of A only | `B` (caller ∉ B) | **404** (was 201 — the bug) |
| Member of A | `A` | 201 |
| any authenticated | _omitted_ | 201 (unchanged) |
| platform admin | any scope | 201 (intended bypass) |

## Post checking
- `cargo check -p api` — green (fix compiles).
- **Follow-up (open):** extend `tools/auth-audit` to specifically detect a handler binding
  `scope_parent_id` (or any caller-supplied parent/scope id) without a `require_grant`/
  `require_view` — today it only flags the generic "no-ensure-owner". Encode the fix so the
  whole class fails the tool, not the user.
- **Case:** file the `CAS_…` record + rename this runbook to `CAS_<rid>-objects-scope-parent-idor.md`
  when the `redpash-slack` MCP case API is reachable (was mid-reconnect at fix time).
