---
title: RBAC — the permission contract
section: Internal
last modified date: 2026-06-07
---

# RBAC — the permission contract

This is the policy layer over the entity-membership graph. The
[entity-membership model](entity.md) answers *"what tier does this caller hold on
this object, and by what reach?"* — that is the `resolve_grant` resolver. The
permission contract answers the orthogonal question: *"for this company, which
teams may take which actions on which object **TYPES**?"* Both are read by one
evaluator. There is no second authorization path.

All of the code below lives in `backend/crates/api/src/rbac.rs` — one module, one
default-deny model. `None` from the resolver means "no membership edge reaches
this object" and that is a denial, never a fallthrough to allow.

## The role spine — `owner > admin > member > viewer`

Four tiers, ordered. In code they are a Rust `enum Role { Viewer, Member, Admin,
Owner }` whose **derived `Ord`** makes the ladder real: `Viewer < Member < Admin
< Owner`, so "highest role wins across all reaches" is a plain `.max()`. The SQL
stores the same rank as an integer (`owner=4 … viewer=1`); `Role::from_rank`
maps it back, and `Role::as_str` serialises the lowercase wire label that matches
the `memberships.role` CHECK constraint.

The ladder is **recursive at every level** — RedPash-root → company → team →
person — and it is a framework default. It is *not* stored in any contract; a
company with no contract at all is still governed by the tier ladder. That is the
whole point of the layering: the ladder is universal, the contract is the
per-company refinement on top.

### Reach: why tier alone is not enough

A `Grant` is the resolved tier **split by reach**, not a single number:

- `direct` — the tier from a membership edge **on the object itself** (own reach:
  a case reporter/assignee, a member of the case team).
- `scope` — the tier from a membership on the object's cascade scope (its
  company / project; for a project file, the file → project → company chain).
- `effective()` — the higher of the two; this is what a plain view gate reads.

The split matters because a case reporter and a bare company member can both be
`member` tier, yet only the reporter holds the object *directly*. Write gates that
need "you must hold this object yourself, not just sit above it in the tree" check
`direct` specifically (`Grant::is_member`, `Grant::scope_at_least`). The reach is
resolved in one recursive CTE (`GRANT_SQL`) that unions the caller with every team
they belong to (nested teams close transitively), then takes `max(rank)` over both
the object and its cascade scopes.

## The gates

There are three handler-facing gates, all default-deny, all returning **404 on
denial** (never 403) so a caller can never learn that an object they can't reach
even exists. Leak-freedom is a contract, not a nicety.

- **`require_view`** — passes if the caller has *any* effective role at *any*
  reach. The read floor.
- **`require_grant`** — the general gate: takes a `rule: Fn(Grant) -> bool`, so a
  handler expresses its exact write requirement (e.g. "direct member or company
  admin") against the reach-split grant.
- **`require_action`** — the **contract-aware** gate (see below), the single gate
  the RBAC epic is converging every endpoint onto.

All three start with the same bypass: `is_platform_admin` short-circuits to allow.
A caller is a platform admin if they are the dev user (dev-mode) **or** their
`users.role` is `"admin"` — that is RedPash-root reach, the top of the recursive
ladder.

The action floor is encoded in `Action::min_tier`: `View → Viewer`,
`Create/Edit → Member`, `Delete → Admin`. This is the universal *vertical* floor;
a tier below it is rejected regardless of any contract grant.

## The contract — the horizontal axis

Without a contract, a tier applies to **every** object type in reach: a company
`member` would be member-tier on cases *and* users *and* payslips alike. The
contract adds the second, orthogonal axis: **per-`(team, object-TYPE)` action
grants**. HR owns `User` + `Payslip`; Engineering owns `Case` + `Monitoring`. HR
is not *over* Engineering — they own different object types. This is capability,
not rank.

The contract is one declarative, **per-company, versioned JSONB** document, stored
in `company_rbac` (schema doc: [`public.company_rbac`](../schemas/public.company_rbac.md)).
In code it is the `Contract` struct: `company` (PK anchor), `owner` (the one
company owner), `admins` (company admins), `labels`, and `grants` — a map of
`team-PK → object-TYPE → ["c","r","u","d"]` subset. Storage is **append-only and
versioned**: every policy change is a new row, never an UPDATE, and the **active
contract is `max(version)`**. That gives a provable, rollback-able audit trail of
who changed policy, when, and to what.

### THE invariant: enforcement is tier-only + PK-anchored

Enforcement branches on the `role` rank, team **PKs**, and object **TYPE** only.
The `labels` map ("Manager" → "owner") and any human-facing `context_role`
("Swarm Lead") are **free-text the user picks and the framework completely
ignores** — pure display. No enforcement path ever reads a name or a label. This
is why truth (`role`) and vocabulary (`context_role`) are separate columns: we do
not care what a company calls its roles.

## Evaluation — how `require_action` decides

1. **Platform-admin bypass** — `is_platform_admin` ⇒ allow.
2. Resolve `object_type` from the rid (registry-driven via the `TypeDefCache`, so
   a new object type resolves without a code edit), `grant = resolve_grant(...)`
   (the vertical tier), and `company_of(object)` to know which contract applies.
3. Load that company's active contract. **`None` (no contract) ⇒ tier-only** —
   exactly today's behaviour. This is what makes the whole layer opt-in and
   non-breaking: an unconfigured company is governed purely by the tier ladder.
4. The pure decision (`evaluate`): if the caller is the **company owner**, allow
   (full subtree). Otherwise admit only when the **tier floor is met AND the
   contract grants the action** for that object type to one of the caller's teams
   (multi-team membership = union of grants; a user's own PK is never a grant key,
   so it contributes nothing). Tier and contract are an **intersection** — both
   must admit.
5. Deny ⇒ 404.

A subtle but load-bearing rule: **`company_admin` is fail-closed.** A company
admin manages the org graph (teams, memberships, users-as-org) plus only the
object types their team is explicitly granted — it does **not** auto-CRUD every
content type. This closes the "can an admin silently read another team's payslips?"
surface: content access is explicit grants only.

> **Reality check (2026-06-07):** the storage (`company_rbac`), the `Contract`
> type, `load_contract`, the pure `evaluate`, and `require_action` are all
> implemented and unit-tested in `rbac.rs`. But **no endpoint calls
> `require_action` yet** — there are zero call-sites under `routes/`. Live
> handlers today gate with `require_view` / `require_grant` (tier + reach only).
> So the horizontal axis is built and proven but not yet enforcing; the cutover
> wires handlers onto `require_action`, and because an absent contract evaluates
> tier-only, that cutover changes nothing until a company actually registers a
> contract.

## Cross-tenant isolation — the see-down-only rule

There is exactly one isolation rule, and it falls out of reach resolution rather
than being a separate mechanism: **a principal sees *down* their subtree — never
up (a parent) or sideways (a sibling).** `resolve_grant` only ever resolves an
edge that reaches *from* the caller (or their teams) *down to* the object; there
is no path that climbs to a parent or hops to a sibling tenant.

That single rule is simultaneously:

- **Tenant isolation** — companies cannot see each other or RedPash, because no
  down-edge connects sibling companies.
- **Platform reach** — RedPash, as the root of the ladder, sees everything below
  it (modelled today as `is_platform_admin`).
- **Partner-manages-clients** — a partner company holding an explicit
  `memberships(object = client_company, member = partner_company, role = admin)`
  edge gets see-down reach over **only its assigned clients**, never all
  companies. No new mechanism: the polymorphic membership edge already allows a
  company/team to be a member, and isolation still holds for everyone else.

The self-overlay is the one deliberate exception inside this model: your own
`User` row is always editable for your own `{profile, email, alias}` regardless of
team grants.

## Source files

- [`code/backend/api/rbac.md`](../../code/backend/api/rbac.md) — the evaluator
  itself: `Role`, `Grant`, `resolve_grant`, the gates (`require_view`,
  `require_grant`, `require_action`), `is_platform_admin`, the `Contract` type
  and `evaluate`.
- [`code/backend/api/field_perms.md`](../../code/backend/api/field_perms.md) —
  the field-depth axis (`require_fields`): per-`(object-TYPE × field × role)`
  enforcement that narrows a write once `require_action` has admitted it.
- [`db/schemas/public.company_rbac`](../schemas/public.company_rbac.md) — the
  append-only, per-company, versioned JSONB contract table.
- [`db/schemas/public.memberships`](../schemas/public.memberships.md) — the
  polymorphic membership edge the contract is policy *over*.
