# RBAC — one polymorphic edge, one resolver, one gate

Every access decision in RedPash flows through a single shape: **a membership
edge on an entity, resolved by reach, gated by `require_action`, denied as 404.**
There is no per-resource permission code — a file, a case, and a custom object
type all reach the same resolver because they are all rows in the **entity
registry**, and reach cascades along an edge relation that is itself **data**
(`type_definitions.scope_parents`). This is day-one decisions #5/#6 made code:
the predecessor accreted three coexisting gate idioms and three hand-synced
copies of the cascade SQL; here there is exactly one of each.

**Source:** [rbac.rs](backend/crates/api/src/rbac.rs) (resolver + gate),
[type_cache.rs](backend/crates/api/src/type_cache.rs) (the generated cascade),
[session.rs](backend/crates/api/src/session.rs) (the `Caller` extractor),
[field_perms.rs](backend/crates/api/src/field_perms.rs) +
[admin.rs](backend/crates/api/src/admin.rs) (the field layer),
[db.rs](backend/crates/api/src/db.rs) (the owner auto-grant).

---

## The entity-membership spine

Two tables carry the whole model
([init.sql](backend/migrations/20260612000000_init.sql)):

- **`entities (id, type)`** — every top-level object is registered here at birth
  ([`register_entity`](backend/crates/api/src/db.rs#L45), same tx as the subtype
  insert; day-one #2). The `type` column is what the cascade and `company_of`
  join against.
- **`memberships (object_redpash_id, member_redpash_id, role, context_role)`** —
  ONE polymorphic edge: a member (a user OR a team) holds a `role` on an object.
  Ownership is a row here, not an `owner_id` column anywhere. `context_role` is
  **free-text display only** — no enforcement path reads it (day-one #9;
  enforced by the [`Contract`](backend/crates/api/src/rbac.rs#L197) invariant
  comment).

`role` is the ordered [`Role`](backend/crates/api/src/rbac.rs#L34) enum
**Viewer < Member < Admin < Owner**, derived so "highest wins" is a plain `max`.
Every create auto-grants the creator an owner edge via
[`grant_owner`](backend/crates/api/src/db.rs#L145) ("there is no object without
an owner") — so the creator is immediately reachable with no extra wiring.

---

## Reach resolution

[`resolve_grant(pool, cache, caller, object)`](backend/crates/api/src/rbac.rs#L94)
returns a [`Grant { direct, scope }`](backend/crates/api/src/rbac.rs#L66) —
access split by REACH:

- **`direct`** — an edge ON the object itself.
- **`scope`** — an edge on something the object *cascades to* (its company, its
  project, …). `Grant::effective()` is `direct.max(scope)`.

The query runs over the **generated** `WITH RECURSIVE` clause
([`rbac_with_clause`](backend/crates/api/src/type_cache.rs#L141)), which has two
CTEs:

1. **`principals`** — the caller plus every team they (transitively) belong to,
   so a team grant counts as the user's own. (Also exposed standalone as
   [`principals()`](backend/crates/api/src/rbac.rs#L176) for list-query
   scoping.)
2. **`scopes`** — the object's ancestor closure, walking the **parent-edge
   relation** (depth-capped at 8 as a cycle guard).

That parent-edge relation is the cascade made data: each builtin type's
`scope_parents` arms (e.g. `project.company_id`, `file.project_id`) are unioned
into one SQL fragment in
[`TypeDefCache::load`](backend/crates/api/src/type_cache.rs#L57), with custom
types covered by a single `entity_data.scope_parent_id` arm. The cascade is
**fully transitive** — file → project → company falls out of the recursion, not
a hand-written join. The same WITH clause backs all three RBAC readers:
`resolve_grant`, the admin
[`grant_edges`](backend/crates/api/src/rbac.rs#L126) introspection, and
[`company_of`](backend/crates/api/src/rbac.rs#L158).

---

## `require_action` — THE gate

[`require_action(pool, cache, caller, object, Action)`](backend/crates/api/src/rbac.rs#L289)
is the only handler-facing gate. In order:

1. **Platform-admin bypass FIRST** — `caller.is_platform_admin` short-circuits
   to `Ok(())`, arriving pre-resolved on the `Caller` so the gate never
   re-queries it.
2. Resolve the grant, the object's company, and (only if a contract exists) the
   principals.
3. [`evaluate`](backend/crates/api/src/rbac.rs#L272): the **vertical tier floor**
   ∩ the **horizontal company contract**.

The tier floor is [`Action::min_tier`](backend/crates/api/src/rbac.rs#L260):

| Action | min role | CRUD |
|---|---|---|
| `View` | Viewer | `r` |
| `Create` / `Edit` | Member | `c`/`u` |
| `Delete` | Admin | `d` |

The horizontal layer is the per-company [`Contract`](backend/crates/api/src/rbac.rs#L197)
(versioned JSONB in `company_rbac`, active = `max(version)`): **no contract ⇒
tier-only** (non-breaking); **company_owner ⇒ full subtree**; otherwise tier AND
`contract.allows(principals, type, crud)`. A `company_admin` is ORG-management
only — **not** auto-content (fail-closed). On deny:
[`AppError::not_found`](backend/crates/api/src/rbac.rs#L311), never 403.

### `require_rule` — the escape hatch

[`require_rule(..., label, rule: Fn(Grant) -> bool)`](backend/crates/api/src/rbac.rs#L328)
exists for **reach-split atoms** the coarse tier floor can't express — predicates
that care about `direct` vs `scope` specifically. Routine CRUD uses
`require_action`; reaching for `require_rule` in a normal handler is a review
finding. Its live use is the **IDOR guard** (day-one #3): when `create` accepts
a caller-supplied `scope_parent_id`, the parent must be reachable at **≥ Member**
before the object can be grafted under it — else any authed user could attach
their object to a foreign scope and inherit that scope's admins as writers
([objects.rs](backend/crates/api/src/objects.rs#L97)). It 404s an
unreachable/foreign parent (leak-free); the FK on `entity_data.scope_parent_id`
additionally makes a dangling parent unrepresentable.

---

## The leak-free 404 invariant

RBAC denial is **404, never 403** — a denied caller cannot distinguish "exists
but not yours" from "doesn't exist"
([error.rs](backend/crates/api/src/error.rs#L38), CLAUDE.md binding rule). Both
gates and the admin surface ([admin.rs](backend/crates/api/src/admin.rs#L34))
deny with `not_found`. The **one sanctioned 403** is the field gate (below):
it runs only *after* reach is already proven, so naming a blocked field leaks
nothing ([error.rs](backend/crates/api/src/error.rs#L43)).

---

## The field-permission layer

After the coarse Edit gate admits the caller, mutations of catalog-backed types
pass a second, finer gate:
[`field_perms::require_fields`](backend/crates/api/src/field_perms.rs#L164).
Every field being written must resolve to `Write` for the caller's effective
tier, or it's a **403 `field_forbidden`** naming the first blocked field.

Per-`(field, role)` cells **derive** from the field's
[`PermClass`](backend/crates/api/src/field_perms.rs#L55) (stored in
`type_fields`, never persisted as cells — so seeds can't drift). The class
maps to a `[owner, admin, member, viewer]`
[matrix](backend/crates/api/src/field_perms.rs#L81):

| class | owner | admin | member | viewer |
|---|---|---|---|---|
| `standard` | W | W | R | R |
| `collaborative` | W | W | W | R |
| `owner_grade` | W | R | R | R |
| `personal` | W | N | N | N |
| `readonly` | R | R | R | R |

The sparse `field_permissions` table (one row per overridden cell, upserted via
**PUT /api/admin/fields**, platform-admin-only) **layers on top** of the
derivation. [`matrix`](backend/crates/api/src/field_perms.rs#L129) merges both
for read-masking; `require_fields` resolves the same way for the write gate.
Tier resolution rides the one resolver (`resolve_grant().effective()`); platform
admins bypass first, like every gate.

---

## `Caller` — the per-request auth context

[`Caller { rid, is_platform_admin }`](backend/crates/api/src/rbac.rs#L28) is an
axum extractor ([session.rs](backend/crates/api/src/session.rs)): cookie →
session row → user rid + admin verdict, behind a 60s TTL cache, so no gate
re-queries the users table. A handler that takes `Caller` **cannot forget auth**
— absence of a session is a typed 401 before the body runs. In **debug builds**
a missing/expired session falls back to the dev bootstrap user (always a platform
admin) so local dev needs zero setup; in **release** it is `AppError::unauthenticated()`
(day-one #10 — the fallback is compile-profile-gated, never an env var).

---

## New object types get RBAC for free

A new TypeDefinition row needs **no RBAC code**. It inherits reach by declaring
its `scope_parents` (the cascade is data), full CRUD + the IDOR guard through the
generic [objects.rs](backend/crates/api/src/objects.rs) handler over
`entity_data`, and the owner auto-grant on create. Adding a builtin's storage
table is the one place to touch:
[`builtin_table`](backend/crates/api/src/type_cache.rs#L42), in the same commit
as the migration. This is the "framework, not product" thesis: declaring a type
wires its access control.

---

## Where it's enforced

Handlers call `require_action` (or `require_rule`) **first**, before touching the
resource — `Action::View` on reads, `Edit` on mutations, `Delete` on removals.
It is wired from the first route and used uniformly across
[files](backend/crates/api/src/files/mod.rs),
[cases](backend/crates/api/src/cases.rs),
[objects](backend/crates/api/src/objects.rs),
[designer](backend/crates/api/src/designer.rs),
[projects](backend/crates/api/src/projects.rs),
[group](backend/crates/api/src/group.rs), and
[settings](backend/crates/api/src/settings.rs). Because the gate's existence
check IS the resolver, a missing or wrong-type rid produces the same leak-free
404 as a denied one.

---

## See also

- [api-routes.md](api-routes.md) — the route surface
  these gates protect.
- [`day-one.md`](../../../decisions/day-one.md) — decisions #2, #3,
  #5, #6, #9, #10 are the WHY behind this model.
