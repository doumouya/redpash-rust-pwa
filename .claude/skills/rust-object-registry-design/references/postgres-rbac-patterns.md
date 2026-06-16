# Postgres → RedPash, part 2: the RBAC model (the "+ RBAC" of the auto-wiring promise)

`postgres-registry-patterns.md` grounds the *object model* (the catalog). This grounds the *permission
model*. The skill's promise is "declare a type → storage + CRUD + **RBAC** + audit + typed fields, free."
The RBAC half holds for one reason: **RedPash's RBAC is type-agnostic** — a single
`require_action(caller, object, action)` / `resolve_grant(caller, object)` serves every object type — and
it's modelled exactly the way Postgres models roles. So a new (even custom) type inherits the whole
permission system without a line of new RBAC code. The proof is PG Chapter 22 "Database Roles."

Docs (PG Ch. 22): role-attributes · role-membership · role-removal · predefined-roles · function-security
(§22.6). RedPash seam: `crates/api/src/rbac.rs` (the gate), `crates/api/src/type_cache.rs`
(`rbac_with_clause` — the recursive CTE GENERATED from `type_definitions.scope_parents`), the
`memberships` table.

---

## 1 · Recursive role membership — the headline (↔ the `principals` closure)

**PG** — roles are members of roles (`GRANT role TO role`), transitively: if `joe ∈ admin` and
`admin ∈ wheel`, `joe` reaches `wheel` through the chain (where `INHERIT` links it). A role *is* a group;
membership is recursive.

**RedPash** — the polymorphic `memberships` table (`member_redpash_id → object_redpash_id`, `role`) + the
**recursive `principals` CTE** inside `type_cache::rbac_with_clause()`: *"caller + every team they belong
to, recursively"* (the `WITH RECURSIVE principals` walk over team-typed membership edges, depth-capped as
a cycle guard). That is PG's role-in-role recursion, exactly. And it is **type-agnostic**: the
`principals` walk + the generated `scopes` cascade resolve against any object id, so a custom type's
grants resolve through the same query — **zero new RBAC code per type**. This is *why* "RBAC for free" is
true. (`principals(pool, caller)` is also exposed for the reach-scoped list filters in `objects.rs`/
`cases.rs`.)

## 2 · INHERIT vs SET ROLE → RedPash auto-inherits, with a reach refinement

**PG** — `INHERIT` (default): a member automatically holds the group's privileges. `NOINHERIT`: you must
`SET ROLE` to use them.

**RedPash** — "INHERIT-style," no `SET ROLE` step: `Grant::effective()` = the highest reaching tier,
applied automatically. RedPash *refines* PG's binary inherit with **reach-split** grants — `Grant`
carries a `direct` membership on the object itself and a `scope` tier cascaded from its parents (the
cascade GENERATED from `type_definitions.scope_parents`). That split (which PG doesn't have) lets a
gate demand own-reach vs accept cascade-reach — `rbac::require_rule` is the escape hatch for those
reach-split rules (e.g. the IDOR guard "≥ Member reach on the supplied scope_parent"), while routine CRUD
uses `require_action`.

## 3 · Role attributes → `is_platform_admin` (the capability flag, kept separate)

**PG** — `LOGIN`/`SUPERUSER`/`CREATEROLE`/`BYPASSRLS` are per-role **flags**, *never inherited via
membership*; `SUPERUSER` bypasses all permission checks. Attributes are a different axis from object
privileges.

**RedPash** — `Caller.is_platform_admin` is the per-principal flag that **bypasses the gates** (the
`SUPERUSER` analog — `require_action`/`require_rule`/`require_fields` all early-return `Ok` for it),
distinct from the inherited 4-tier object roles (`Role { Viewer < Member < Admin < Owner }`). PG's
attributes-vs-object-privileges split is RedPash's **platform-admin-flag vs membership-tier** split.
*Lesson*: keep "is root" separate from "owns this object"; never fold the god-flag into the inheritable
tiers.

## 4 · ADMIN OPTION → the membership-mutation gate (≥Admin), not a free-text label

**PG** — `WITH ADMIN OPTION` lets a member `GRANT`/`REVOKE` the role to others; `WITH SET` controls
`SET ROLE`. "Who may hand the role onward" is itself a granted permission.

**RedPash** — the analog is the membership-mutation gate: a caller may grant a role onward only at a tier
`>= Role::Admin` on the object (a `require_rule` reach-split). *Caveat the skill must flag (day-one #9):*
`context_role` is a **free-form human label the framework ignores for enforcement** (like a PG role's
name/comment) — it is NOT the ADMIN-OPTION primitive, and **no enforcement path may read it**. The
predecessor string-keyed workflow identity on it and broke when a label was renamed; case
reporter/assignee are typed FK columns (workflow refs), not access edges.

## 5 · Predefined roles → least-privilege delegation (never hand out the flag)

**PG** — `pg_monitor` / `pg_read_all_data` / `pg_signal_backend` … are system roles you `GRANT` to
delegate a specific capability **without** `SUPERUSER`. Delegate via membership, not via the
god-attribute.

**RedPash** — grant a scoped tier/membership, **never** the `is_platform_admin` flag. *Lesson*: build
scoped capability roles; all-or-nothing superuser is the anti-pattern PG's predefined roles exist to
avoid.

## 6 · Dropping roles → cascade vs reassign for a removed principal

**PG** — `DROP ROLE` **auto-revokes the role's memberships**, but *fails* if the role owns objects; you
must `REASSIGN OWNED` (transfer) or `DROP OWNED` (drop + revoke) **first**.

**RedPash** — the entity registry cascades (`entities` PK `ON DELETE CASCADE`, membership edges with it),
and the lean code answers the question PG forces directly: deleting a `user` is **SCRUB-RETAINED**, not a
hard delete — `objects.rs::delete_one` blocks (`409 sole_owner_blocker`) if the user solely owns any
object (`db::user_sole_owner_objects`), forcing ownership transfer first, then anonymizes + retains
(audit survives, sessions are invalidated). That is `REASSIGN OWNED`-before-`DROP` made mandatory.
*Lesson*: make the ownership-transfer-vs-cascade decision explicit for principal removal.

## 7 · Function Security → "run-as" (SECURITY DEFINER, done safely)

**PG** — `SECURITY INVOKER` (default, runs as caller) vs `SECURITY DEFINER` (runs as the function
*owner*); a DEFINER function must not trust caller-controlled context.

**RedPash** — a deferred/connector load that runs on someone's behalf pins the principal and **re-checks
their grants at run time, with no platform-admin bypass** (`pipeline::upload_csv` takes an explicit
`caller` + `caller_is_admin`; connectors pass `false`, so RBAC is re-resolved as the named user). That's
`SECURITY DEFINER` done right — privileges are the named user's, *re-verified at execution* rather than
trusted from registration. *Lesson*: when an operation runs later (a job, a connector), pin the principal
and re-check their grants then.

## Quick map

| Postgres (Ch. 22) | RedPash | seam |
|---|---|---|
| recursive role membership | `memberships` + recursive `principals` CTE (type-agnostic) | `type_cache::rbac_with_clause`, `rbac::principals` |
| INHERIT / SET ROLE | auto-inherit; refined by reach-split `Grant` | `rbac::Grant::effective`, `require_rule` |
| role attributes (SUPERUSER) | `is_platform_admin` flag (bypass), separate from tiers | `Caller`, every `require_*` early-return |
| ADMIN OPTION | ≥`Role::Admin` to mutate memberships (NOT `context_role`, day-one #9) | the members-manage `require_rule` |
| predefined roles | scoped delegation, never the god-flag | membership tiers |
| DROP ROLE / REASSIGN·DROP OWNED | entity cascade + the user SCRUB-RETAIN (sole-owner block) | `objects::delete_one`, `db::user_sole_owner_objects` |
| SECURITY DEFINER | run-as, RBAC re-checked at execution, no admin bypass | `pipeline::upload_csv(caller, caller_is_admin=false)` |

## Bottom line

PG Chapter 22 is the proven design for **type-agnostic RBAC** — principals + recursive membership + a
capability flag held apart from object tiers. RedPash's `require_action`/`resolve_grant` + the
`principals` closure + the `Viewer<Member<Admin<Owner>` spine + `is_platform_admin` *are* that model, one
level up — and the cascade is GENERATED from `type_definitions.scope_parents` (one declaration, every
consumer; day-one #6). Because RBAC keys off **principals and membership, never the object's type**, a
new TypeDefinition gets the entire permission system for free — which is the "+ RBAC" the registry
promises. When designing an RBAC change, ask: *how does Postgres' role system do it?*
