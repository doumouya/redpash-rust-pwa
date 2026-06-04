# Postgres → RedPash, part 2: the RBAC model (the "+ RBAC" of the auto-wiring promise)

`postgres-registry-patterns.md` grounds the *object model* (the catalog). This grounds the *permission model*.
The skill's promise is "declare a type → storage + CRUD + **RBAC** + audit + typed fields, free." The RBAC half
holds for one reason: **RedPash's RBAC is type-agnostic** — a single `resolve_grant(caller, object)` serves every
object type — and it's modelled exactly the way Postgres models roles. So a new (even custom) type inherits the
whole permission system without a line of new RBAC code. The proof is PG Chapter 22 "Database Roles."

Docs (PG Ch. 22): role-attributes · role-membership · role-removal · predefined-roles · function-security
(`perm-functions.html` = §22.6). RedPash seam: `crates/api/src/rbac.rs`, `routes/members.rs`, the `memberships` table.

---

## 1 · Recursive role membership — the headline (↔ the `principals` closure)

**PG** — roles are members of roles (`GRANT role TO role`), transitively: if `joe ∈ admin` and `admin ∈ wheel`,
`joe` reaches `wheel` through the chain (where `INHERIT` links it). A role *is* a group; membership is recursive.

**RedPash** — the polymorphic `memberships` table (`member_redpash_id → object_redpash_id`, `role`) + the
**recursive `principals` CTE** in `GRANT_SQL` (rbac.rs:86–114): *"caller + every team they belong to, recursively"*
(the `WITH RECURSIVE principals` walk over team-typed membership edges). That is PG's role-in-role recursion,
exactly. And it is **type-agnostic**: the `principals` walk + `cascade_scopes` resolve against any object id, so a
custom type's grants resolve through the same query — **zero new RBAC code per type**. This is *why* "RBAC for free"
is true.

## 2 · INHERIT vs SET ROLE → RedPash auto-inherits, with a reach refinement

**PG** — `INHERIT` (default): a member automatically holds the group's privileges. `NOINHERIT`: you must `SET ROLE`
to use them.

**RedPash** — "INHERIT-style," no `SET ROLE` step: `Grant::effective()` = `max(direct, scope)` (rbac.rs), the highest
reaching tier applies automatically. RedPash *refines* PG's binary inherit with **reach-split** grants —
`Grant { direct, scope }`: `direct` = a membership on the object itself; `scope` = a tier cascaded from its
company/project. That split (which PG doesn't have) lets write-gates demand own-reach (a case reporter) vs accept
cascade-reach (a company member) — finer than role inheritance alone.

## 3 · Role attributes → `is_platform_admin` (the capability flag, kept separate)

**PG** — `LOGIN`/`SUPERUSER`/`CREATEROLE`/`BYPASSRLS` are per-role **flags**, *never inherited via membership*;
`SUPERUSER` bypasses all permission checks. Attributes are a different axis from object privileges.

**RedPash** — `is_platform_admin` (rbac.rs:222) is the per-principal flag that **bypasses the gates** (the
`SUPERUSER` analog), distinct from the inherited 4-tier object roles. PG's attributes-vs-object-privileges split is
RedPash's **platform-admin-flag vs membership-tier** split. *Lesson*: keep "is root" separate from "owns this
object"; never fold the god-flag into the inheritable tiers.

## 4 · ADMIN OPTION → the membership-mutation gate (≥Admin), not the label

**PG** — `WITH ADMIN OPTION` lets a member `GRANT`/`REVOKE` the role to others; `WITH SET` controls `SET ROLE`.
"Who may hand the role onward" is itself a granted permission.

**RedPash** — the analog is the membership-mutation gate: `routes/members.rs::add` admits only a caller whose tier
`>= Role::Admin` on the object (rbac.rs:93). So "who can grant a role onward" = **Admin+ on the object**.
*Caveat the skill should flag*: `context_role` (rbac.rs:139, :289) is a **free-form human label the framework
ignores for enforcement** (like a PG role's name/comment) — it is NOT the ADMIN-OPTION primitive; don't gate on it.

## 5 · Predefined roles → least-privilege delegation (never hand out the flag)

**PG** — `pg_monitor` / `pg_read_all_data` / `pg_signal_backend` … are system roles you `GRANT` to delegate a
specific capability **without** `SUPERUSER`. Delegate via membership, not via the god-attribute.

**RedPash** — grant a scoped tier/membership, **never** the `is_platform_admin` flag. The read-scoped platform
surfaces — Monitoring = read observability, Admin Console = org management ([[page-purpose-split]]) — are the
`pg_monitor`-style scoped delegation. *Lesson*: build scoped capability roles; all-or-nothing superuser is the
anti-pattern PG's predefined roles exist to avoid.

## 6 · Dropping roles → cascade vs reassign for a removed principal

**PG** — `DROP ROLE` **auto-revokes the role's memberships**, but *fails* if the role owns objects; you must
`REASSIGN OWNED` (transfer) or `DROP OWNED` (drop + revoke) **first**.

**RedPash** — `entities`/`memberships` `ON DELETE CASCADE`: `delete_entity` auto-cascades the membership edges (the
"DROP ROLE auto-revokes memberships" analog). The open question PG *forces* you to answer: a removed user's owned
objects (their projects/files) — **cascade-delete or reassign?** *Lesson*: make the ownership-transfer-vs-cascade
decision explicit for principal removal, exactly as `REASSIGN OWNED` vs `DROP OWNED` forces it.

## 7 · Function Security → `as_user` "run-as" (SECURITY DEFINER, done safely)

**PG** — `SECURITY INVOKER` (default, runs as caller) vs `SECURITY DEFINER` (runs as the function *owner*);
`search_path` safety = a DEFINER function must not trust caller-controlled context.

**RedPash** — the connector `as_user` "run-as": a deferred load runs **AS the picker** (connectors.rs:69), with RBAC
**re-checked at load time, no platform-admin bypass**. `as_user` ≈ `SECURITY DEFINER` done right — the privileges
are the named user's, *re-verified at execution* rather than trusted from registration. *Lesson*: when an operation
runs on someone's behalf later (a job, a connector), pin the principal and re-check their grants at run time.

## Quick map

| Postgres (Ch. 22) | RedPash | seam |
|---|---|---|
| recursive role membership | `memberships` + recursive `principals` CTE (type-agnostic) | rbac.rs:86–114, :117 |
| INHERIT / SET ROLE | auto-inherit; refined by reach-split `Grant{direct,scope}` | rbac.rs `effective()` |
| role attributes (SUPERUSER) | `is_platform_admin` flag (bypass), separate from tiers | rbac.rs:222 |
| ADMIN OPTION | ≥`Role::Admin` to mutate memberships (NOT `context_role`) | members.rs:93/`add` |
| predefined roles | scoped delegation, never the god-flag | Monitoring/Admin split |
| DROP ROLE / REASSIGN·DROP OWNED | `ON DELETE CASCADE` + the owned-objects decision | `delete_entity` |
| SECURITY DEFINER | `as_user` run-as, RBAC re-checked at execution | connectors.rs:69 |

## Bottom line

PG Chapter 22 is the proven design for **type-agnostic RBAC** — principals + recursive membership + a capability
flag held apart from object tiers. RedPash's `resolve_grant` + the `principals` closure + the `Owner>Admin>Member>
Viewer` spine + `is_platform_admin` *are* that model, one level up. Because RBAC keys off **principals and
membership, never the object's type**, a new TypeDefinition gets the entire permission system for free — which is
the "+ RBAC" the registry promises. When designing an RBAC change, ask: *how does Postgres' role system do it?*
