# objects create — cross-tenant `scope_parent_id` IDOR (FIXED)

Historical reasoning record for a MEDIUM Authorization (IDOR / scope-injection) bug in
the generic object-create handler. **Fixed on lean** — the create-time reach gate, the DB
FK, the regression test, and the audit detector that pins the whole class are all in the
tree. Day-one decision #3 (`entity_data.scope_parent_id` has a real FK) was locked by this
incident. Tracked as CAS_DD6F55FB (guard + test) and CAS_26EC (auth-audit detector).

Source:
[`objects.rs`](../../../backend/crates/api/src/objects.rs) (the `create` handler),
[`rbac.rs`](../../../backend/crates/api/src/rbac.rs) (`require_rule`),
[`objects_idor.rs`](../../../backend/crates/api/tests/objects_idor.rs) (the regression test).
On lean the handler lives at `backend/crates/api/src/objects.rs` — there is **no
`routes/` subdir** (that was the prerelease layout, where the bug and the d3f933a fix were
first recorded against `routes/objects.rs`).

## Problem statement

An automated background security review flagged a MEDIUM IDOR / scope-injection in `create`
(POST `/api/objects/:type`): `body.scope_parent_id` is caller-supplied and was bound
straight into the `entity_data` INSERT with **no authorization** against the caller's reach
to that parent scope.

## Verification (how it was confirmed before fixing)

A 5-agent adversarial workflow (3 readers → 2 verifiers) checked it against the real RBAC
model. Both verifiers returned **exploitable=true, high confidence**; the agent tasked with
*refuting* it reported "refutation fails" — no upstream guard, FK, RLS, or downstream
re-check protected the column at the time.

## Root cause (the pre-fix state)

- The `create` handler ran only `require_type` + the INSERT — **no RBAC check** on
  `scope_parent_id`.
- The `/objects` route has **no auth middleware** beyond the `Caller` extractor
  (contrast `/admin`, gated platform-admin), so any session-authenticated non-admin reaches
  it. ("Extraction IS the gate" gives authentication, not per-object reach — that is the
  handler's job.)
- `entity_data.scope_parent_id` was a nullable `TEXT` column with **no FK / CHECK / trigger
  / RLS**, so even direct-DB or future code paths could write a dangling or foreign parent.
- The injected value is **live in RBAC**: the reach-scoped list `REACH` clause keys on it
  (`objects.rs`, `m.object_redpash_id IN (ed.object_id, ed.scope_parent_id)`), and the
  scope cascade in `rbac.rs` flows a parent's grants down to the child.

**Impact (precise):** *not* upward takeover — the cascade flows parent→child, so the
attacker gains no access *into* the victim scope. The harm is cross-tenant **injection**:
an attacker grafts an attacker-owned object under a scope B they don't belong to; it then
(a) surfaces to every B member in their list results and (b) hands B's admins a cascade
grant (incl. write/delete) over the attacker's object. A cross-tenant visibility +
integrity / data-pollution IDOR.

## The lean fix

Two defence layers, in order:

**1. Policy — create-time reach gate** (`objects.rs`, in `create`). When
`body.scope_parent_id` is set, require **≥ Member** reach on the parent before the INSERT:

```rust
// backend/crates/api/src/objects.rs — create()
if let Some(parent) = body.scope_parent_id.as_deref() {
    let kind = state.type_cache.object_kind(parent);
    rbac::require_rule(&state.db, &state.type_cache, &caller, parent, kind, |g| {
        g.effective().is_some_and(|r| r >= Role::Member)
    })
    .await?;
}
```

- `require_rule` ([`rbac.rs`](../../../backend/crates/api/src/rbac.rs)) **404s leak-free** on
  no reach — an existing-but-foreign scope is indistinguishable from a missing one (no
  IDOR-by-error-message). This is lean's reach-split escape hatch; the prerelease record
  named it `require_grant`.
- `object_kind` **default-denies** an unknown id (resolves an empty grant → 404).
- **Platform-admin bypass** via `caller.is_platform_admin` is intended (the `require_rule`
  short-circuit).
- The same `require_rule >= Member` pattern guards the org-builtin create path
  (`builtin_create`, `objects.rs`) — the live in-repo precedent for "write into a parent
  scope needs Member reach".

**2. DB — a real FK** (`backend/migrations/20260612000000_init.sql`):
`scope_parent_id text REFERENCES entities(id) ON DELETE SET NULL`. Day-one #3 makes a
dangling/foreign parent **unrepresentable** even for direct-DB writes or future code paths
that bypass the handler — the policy check is the front door, the FK is the wall. See
[`day-one.md`](../../decisions/day-one.md) #3 and [`schema.md`](../code/backend/schema.md).

**Tier decision (Em, 2026-06-08): Member+.** Not Viewer+ (attaching an object is a *write*
into the scope, so view-only members must not inject). Not Admin+ (creating content in a
scope you belong to is a normal Member action; Admin+ would lock legitimate members out of
their own scope).

## Regression test

[`backend/crates/api/tests/objects_idor.rs`](../../../backend/crates/api/tests/objects_idor.rs)
— `object_registry_idor_and_reach`. It seeds REAL non-admin callers (the dev-user
fake-green trap) and exercises the same `require_rule` / `require_action` gates the handler
calls. Needs `DATABASE_URL`; skips cleanly when unset. Covered cases:

| Caller | `scope_parent_id` | Expect |
|---|---|---|
| Member of A only | `B` (caller ∉ B) | **404** (was 201 — the bug) |
| Member of A | `A` | 201 |
| Member of A | _omitted_ | 201 (unchanged) |
| any (raw DB) | bogus / dangling | DB FK refuses (defence-in-depth) |
| platform admin | any scope | bypass (intended) |

It also asserts the reach-scoped list: a member reaches the in-scope object (cascade) + an
owned free object; a stranger reaches neither — and that delete needs Admin.

## The class detector (no longer an open follow-up)

The prerelease record left "extend the audit to flag this class" open. It has landed:
[`tools/auth-audit/audit.js`](../../../tools/auth-audit/audit.js) Cat-4 flags any handler
that reads `scope_parent_id` (or a caller-supplied parent/scope id) and binds it into a
write **without** a reach gate. `callsReachGate` recognizes the `rbac::require_*` family
(incl. `require_rule` — lean's name; prerelease used `require_grant`), so `create` stays
green and a future regression fails the tool, not the user. Red→green fixtures live in
`tools/auth-audit/test/scope-parent.test.js`.

## Status

- Guard: `objects.rs` `create` (commit d3f933a, prerelease `routes/objects.rs`; carried to
  lean's flat `objects.rs`). `cargo check -p api` green.
- DB FK: day-one #3, `20260612000000_init.sql`.
- Regression test: `tests/objects_idor.rs` (CAS_DD6F55FB).
- Audit detector: `auth-audit` Cat-4 (CAS_26EC, commit f5cda92).
