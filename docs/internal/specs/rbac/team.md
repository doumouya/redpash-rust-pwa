---
title: Team — permission catalog
section: Internal
order: 65
last modified date: 2026-05-31
owner: Torv
status: enforced 2026-05-31 — object-level gate live: view=require_view; update=require_grant(effective>=Admin); delete=require_grant(effective>=Owner); create gates on parent-company reach (any company member+ can plant a team); member CRUD nested at `/:rid/members` via the shared `routes/members.rs` module (reach-aware manage). The per-field atoms below are the v3 custom-role target. RBAC catalog sweep ([index](index.md))
---

# Team (TEM_) — permissions

Permission keys + default grant matrix for the Team object. Derived
from the team table (migration `20260529000000_init.sql` §2:
`teams(redpash_id, company_id, name, created_at)`); see the
[catalog template](index.md) for the key scheme + role tiers.

**View reaches Team supports:** Team is a company-scoped object — its
`company_id` is the parent company. So a team supports two reaches:
`own` = the caller holds a direct membership on the team (via the
unified `memberships` table); and `company` = the caller's reach
cascades from the parent company (a company admin manages all its
teams' rosters). `all` = platform admin.

Team is also itself a **grant-bearing principal**: a user holding a
team membership inherits the team's grants on any object the team is
seated on (`rbac::caller_principals` closes recursively). The team's
own permission catalog (this doc) is about the team row itself; the
"teams as principals" closure is a property of the resolver, not a
team atom.

Member-management calls (add/remove/role-change) are specced on the
[Membership](membership.md) object since the membership row is the
mutated entity; Team's atoms cover the team row itself.

---

## 1. Atoms

View-rooted (per [index](index.md#key-scheme)): `view` is the root,
writes derive from it. `read`/`list`/`search` are all `team.view` —
the reach decides *which* teams the list returns (and `view.all`
returns the global directory).

### View atoms

| Atom | Covers | Reach | Notes |
|---|---|---|---|
| `team.view` | the team (detail / list / search) | own · company · all | `own` = the caller holds a direct membership on the team; `company` = the caller is in the team's parent company; the admin list returns every team with `my_role` |
| `team.view.all` | every team | all | platform admin — and the global directory listing at `/api/admin/teams` |
| `team.view.field.<name>` | one field | inherits the row reach | **allow-list**, one per readable field: `name` · `company_id` (+ read-only `created_at`). Standard bundles hold `view.field.all`; *subsetting fields is a custom-role (v3) feature* |
| `team.view.field.all` | every field | own · company · all | the "see the whole record" atom; **required to delete** |

### Write atoms (derive from a view atom)

| Atom | Derives from | Reach | Notes |
|---|---|---|---|
| `team.create` | parent `company.view` (member+) | — (no row yet) | Creator seated as `owner` in one TX. Caller must reach the parent company at member+ (`rbac::require_grant(company, effective.is_some())`) so an outsider can't plant a team. Platform admin bypasses. |
| `team.name.update` | `team.view.field.name` | own · company · all | owner/admin rename |
| `team.delete` | `team.view.field.all` | own · company · all (**owner-only**) | owner-only at the team tier; CASCADEs memberships where the team is the object |

**No atoms for:** `redpash_id`, `created_at` — auto / server-assigned.
**Intentionally not exposed:** `team.company_id.update` — moving a
team across companies changes its inherited grants on every object
the team is seated on. That's an audit-eventful path; spec'd for v3,
not the current PATCH endpoint.

---

## 2. Grant matrix

Default role-bundle → atom mapping. Cell = the **reach** the bundle
grants (or `—`). Columns: platform `admin`; the team-direct bundles
`owner`/`admin`/`member`; the parent-company bundles
`co:owner`/`co:admin`/`co:member` (reach via company cascade); and
`auth`, any authenticated user. Wider reach wins on union.

| Atom | plat:admin | tm:owner | tm:admin | tm:member | co:owner | co:admin | co:member | auth |
|---|---|---|---|---|---|---|---|---|
| `team.view` | all | own | own | own | company | company | company | — |
| `team.view.field.all` | all | own | own | own | company | company | company | — |
| `team.create` | ✓ | — | — | — | ✓ | ✓ | ✓ | — |
| `team.name.update` | all | own | own | — | company | company | — | — |
| `team.delete` | all | own | — | — | company | — | — | — |

Reading the matrix: any **company member** (or higher in their
company) can create a team — and is seated `owner`. A **team
member** views the team (whole record) but mutates nothing. A
**team admin** renames the team. A **team owner** also deletes.
The **company cascade** mirrors: a company admin manages all its
teams' metadata + rosters; a company owner can delete any of its
teams. `team.view.all` (the admin global directory) is
platform-admin reach.

---

## 3. Notes

- **The team list is *scoped*, not global.** Unlike Companies (which
  surfaces every row globally so users can discover and join),
  `/api/teams` returns the caller's team set — direct + cascade-via-
  company. The admin global directory rides `team.view.all` at
  `/api/admin/teams` (Home Teams tab).

- **`team.delete` is owner-only.** Deleting a team CASCADEs the
  membership rows where the team is the object (and incidentally, in
  the resolver, removes the team's grants on every object the team
  was seated on — a deletion is also a revocation). Owner-only at
  the team tier; company owner via cascade; platform admin always.

- **`team.create` is parent-company-gated.** The handler runs
  `rbac::require_grant(company_id, effective.is_some())` — any
  company member tier can plant a team. The CHECK fires before the
  FK insert so an outsider gets `404 not_found` (leak-free), not a
  `400 bad_request`.

- **`team.company_id.update` is intentionally absent.** Moving a
  team across companies changes its inherited grants on every
  scoped object the team is seated on (every project/case/file the
  team has access to via grant inheritance). That's not a sparse
  PATCH; it's a transfer with cross-object cascade implications.
  Specced for v3, not the current `/api/teams/:rid` PATCH endpoint.

- **Teams as principals (resolver closure).** A team membership is
  ALSO a grant-carrying edge: the user inherits whatever grants the
  team holds on other objects. The closure lives in
  `rbac::caller_principals` (recursive CTE over team memberships).
  This is a *resolver* property, not a team atom — a team doesn't
  grant `team.view` on itself by being seated, the membership row
  does that directly.

- **Member management lives on [Membership](membership.md).** Adding,
  removing, and role-changing team members mutate team-scope
  `memberships` rows — those atoms (`membership.create@team`, etc.)
  are specced there. Reach-aware: a company admin manages any of
  its teams' rosters even without a direct team membership, via the
  shared `routes/members.rs` module + `resolve_grant`. The
  last-owner guard fires on `db::company_owner_count` (object-
  agnostic, despite the legacy name).

- **Last-owner guard** (cross-ref): the team can't be left owner-less
  — enforced on the Membership side (`db::company_owner_count`), not
  via a Team atom.
