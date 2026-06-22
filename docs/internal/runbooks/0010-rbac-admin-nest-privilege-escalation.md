# 0010 — The `/admin` surface had no platform-admin gate (privilege escalation)

Historical reasoning record. The bug below lived in the **predecessor** codebase
(the original `redpash-rust-pwa`, the reference the lean rebuild ports from). The
lean tree closes it *by construction* — the admin verdict is resolved once on the
typed `Caller` and the gate is the FIRST line of every `/admin` handler, so there
is no open fix to apply here. This runbook preserves the WHY because it is the
critical (security) finding that anchored the RBAC epic, and because lean's gate
shape is a direct response to it.

Ties to the RBAC model: see [rbac.md](../code/backend/rbac.md) (one polymorphic
edge, one resolver, one gate) and day-one decisions
[#5/#6](../../decisions/day-one.md) (one gate generation; cascade arms are data).

## Symptom (predecessor)

A full RBAC audit (`wf_f6c0350e`, 2026-06-01) found multi-tenancy enforcement
broken in **both** directions. The worst, live finding: **any authenticated user
could `POST /api/admin/memberships` and grant themselves `owner` of any
company / project / case / team** — full privilege escalation, which makes every
other RBAC check moot. The whole `/api/admin/*` family was "dev-permissive": the
read endpoints (`GET /admin/{users,companies,files,charts,steps,teams,
memberships}`) leaked every tenant's data, and the mutating ones
(`DELETE /admin/{users,companies,memberships}`) edited any tenant's state.

Stakes (Em): cross-tenant data exposure / unauthorized edits = GDPR + contract +
trust-destroying, potentially criminal. Treated as breach-prevention.

## Root cause

An **asymmetry**, not N forgotten handler checks. The predecessor's `/monitoring`
route-nest carried a `require_platform_admin_mw` **layer** that 404'd non-admins
before any handler ran. The `/admin` nest had **no such layer** — even though
`require_platform_admin_mw`'s own doc said it was meant to cover "the Admin
Console group." The per-handler `is_platform_admin` checks that *did* exist on a
few admin endpoints (`list_fields`, `put_field`, …) were therefore the exception;
the membership/user/company endpoints simply never got one. A gate that lives in a
*nest layer* is easy to forget on a sibling nest, and nothing fails loudly when you
do — the routes just answer.

## How lean closes it (by construction)

Lean does not gate `/admin` at the nest layer at all — there is no
`require_platform_admin_mw` in the tree. Three design choices remove the failure
class:

1. **The admin verdict is pre-resolved on the `Caller`.** The session extractor
   ([`session.rs`](../../../backend/crates/api/src/session.rs)) resolves
   `is_platform_admin` ONCE per request from `users.role = 'admin'` (debug builds
   fall back to the dev bootstrap user, always admin; release has no such bypass —
   day-one [#10](../../decisions/day-one.md)). Handlers that take `Caller` cannot
   forget auth — absence of a session is a typed 401 before the body runs — and
   the admin bit arrives typed, so no gate re-queries the users table.

2. **The gate is the FIRST line of the handler, not a layer.**
   [`admin.rs`](../../../backend/crates/api/src/admin.rs) — `put_field`:

   ```rust
   // Platform-admin gate FIRST — leak-free for everyone else.
   if !caller.is_platform_admin {
       return Err(AppError::not_found("not_found", "admin fields"));
   }
   ```

   The check sits at the top of the handler body, on the per-request value, so it
   travels with the route definition — you can't add an `/admin` route without the
   handler signature pulling in `Caller`, and the convention is to gate before any
   work. `/monitoring` mirrors the exact same shape via a `require_admin(caller)`
   helper ([`monitoring.rs`](../../../backend/crates/api/src/monitoring.rs)), which
   also returns the leak-free 404 — the two surfaces are now symmetric instead of
   one carrying a layer the other lacks.

3. **Leak-free 404, never 403.** Denial is `AppError::not_found` (standing
   inheritance, [day-one.md](../../decisions/day-one.md)), so a non-admin can't
   even tell `/api/admin/*` exists — same response a wrong path would give. The
   same posture runs through the routine RBAC gate:
   [`rbac.rs`](../../../backend/crates/api/src/rbac.rs) `require_action` (and the
   `require_rule` escape hatch) bypass FIRST on `caller.is_platform_admin` and 404
   on every other denial.

The lean `/admin` nest is also far smaller than the predecessor's: it is a single
platform-admin-only surface (`PUT /fields`, the `field_permissions` override
upsert). The membership/user/company management that the predecessor exposed under
`/admin` is not re-implemented as an ungated dump — reach-scoped org-admin
self-service lives behind `require_action`/`require_rule`, not a god-mode `/admin`
list (`main.rs` shows `/admin` nested alongside the reach-aware surfaces, every
state-changing method also behind the CSRF origin guard).

## Why this is the right shape long-term

A nest-layer gate is a second place the access rule can live — and the predecessor
proved it is a place you forget. Moving the verdict onto the typed `Caller` and the
check into the handler makes "is this admin-only?" a property you read at the
handler, next to the work it guards, and makes adding an unguarded admin route a
visible omission rather than a silent one. It is the same move day-one
[#5](../../decisions/day-one.md) makes for routine access (one handler-facing gate,
wired from the first route) — the predecessor accreted three coexisting gate
idioms, and the audit found owner-only legacy gates on endpoints whose siblings
were reach-aware. One gate shape, applied first, denied as 404.

## Verify (on lean)

- `cargo test -p api` — RBAC enforcement is exercised through `rbac.rs`'s unit
  tests (tier floor ∩ contract, company-owner override) and the IDOR guard
  (`tests/objects_idor.rs`); the platform-admin bypass is the first arm of
  `require_action`/`require_rule`.
- Spot-check the gate site: `admin::put_field` and `monitoring::require_admin`
  both begin with `if !caller.is_platform_admin → not_found` — the two surfaces a
  nest-layer would have had to cover, now covered in-handler and symmetrically.
- The static route audit (`tools/lib/rust-routes.js`) records the lean cut as
  `rbac: { source: 'handler', hint: null }` for `/admin` — its `GATE_MW` list is
  empty, so it finds no nest-layer `.layer(...)` (`source: 'nest-layer'`, the only
  case that would carry `hint: 'platform_admin'`). That is the predecessor's shape,
  by design absent here: the in-handler `caller.is_platform_admin` check lives in the
  handler body the static pass can't see into, so the audit's role is to confirm
  `/admin` carries NO nest-layer gate, not to detect the in-handler one. If a
  nest-layer gate is ever introduced, its mw name is added to `GATE_MW` and the row
  flips to `source: 'nest-layer'`.

## Sibling findings (same audit)

The same `wf_f6c0350e` audit motivated the rest of the RBAC epic; the other
cross-tenant finding that became its own historical record is the
`scope_parent_id` IDOR in `objects.rs::create` — see
[objects-scope-parent-idor.md](objects-scope-parent-idor.md). Both are closed on
lean; neither is an open issue here.
