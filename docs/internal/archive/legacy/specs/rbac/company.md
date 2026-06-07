---
title: Company — permission catalog
section: Internal
order: 53
last modified date: 2026-05-31
owner: Torv
status: enforced 2026-05-31 — object-level gate live: read=any member; update=require_grant(effective>=Admin); delete=effective>=Owner; member CRUD via the generic members module at /:rid/members (owner/admin manage, self-leave). RBAC catalog sweep ([index](index.md))
---

# Company (CMP_) — permissions

Permission keys + default grant matrix for the Company object. Derived
from [company metadata](../object-metadata/company.md); see the
[catalog template](index.md) for the key scheme + role tiers.

**View reaches Company supports:** Company IS the company-scope root —
its own `redpash_id` is what the `company` reach resolves against.
`own` here means "a company the caller holds a membership on" (via the
unified `memberships` table, `member_redpash_id` = the holder); `all` =
platform admin. No `project` reach (Company has no `project_id`).
Company is also the **company-role source** (`memberships.role` on
company-typed rows — owner/admin/member at the company route layer).

Member-management calls (add/remove/role-change) are specced on the
[Membership](membership.md) object since the membership row is the
mutated entity; Company's atoms cover the company row itself.

---

## 1. Atoms

View-rooted (per [index](index.md#key-scheme)): `view` is the root,
writes derive from it. `read`/`list`/`search` are all `company.view` —
the reach decides *which* companies the list returns (and `view.all`
returns the global directory).

### View atoms

| Atom | Covers | Reach | Notes |
|---|---|---|---|
| `company.view` | the company (detail / list / search) | own · all | `own` = the caller holds a membership on the company; the list returns the caller's companies with `my_role` |
| `company.view.all` | every company | all | platform admin — and the global directory listing (every company, `my_role` null when not a member) |
| `company.view.field.<name>` | one field | inherits the row reach | **allow-list**, one per readable field: `name` · `slug` · `avatar_url` (+ read-only `created_at`). Standard bundles hold `view.field.all`; *subsetting fields is a custom-role (v3) feature* |
| `company.view.field.all` | every field | own · all | the "see the whole record" atom; **required to delete** |

### Write atoms (derive from a view atom)

| Atom | Derives from | Reach | Notes |
|---|---|---|---|
| `company.create` | object `company.view` | — (no row yet) | Creator seated as `owner` in one TX. Any authenticated user. |
| `company.name.update` | `company.view.field.name` | own · all | owner/admin rename |
| `company.slug.update` | `company.view.field.slug` | own · all (**owner-only**) | URL slug; owner-only (changing it breaks links) — see Notes |
| `company.avatar_url.update` | `…field.avatar_url` | own · all | owner/admin reskin |
| `company.delete` | `company.view.field.all` | own · all (**owner-only**) | owner-only at the company tier (projects SET NULL, memberships CASCADE) — see Notes |

**No atoms for:** `redpash_id`, `owner_id`-equivalent (ownership lives
in a `memberships` row with `role='owner'`, not a column on companies),
`created_at` — auto / server-assigned.

---

## 2. Grant matrix

Default role-bundle → atom mapping. Cell = the **reach** the bundle
grants (or `—`). Columns: platform `admin`; the membership bundles
`owner`/`admin`/`member`/`viewer` — here "the caller's role *in the
company being acted on*" — and `co-mem`, a bare company membership.
Wider reach wins on union.

| Atom | plat:admin | co:owner | co:admin | co:member | co:viewer | co-mem |
|---|---|---|---|---|---|---|
| `company.view` | all | own | own | own | own | own |
| `company.view.field.all` | all | own | own | own | own | own |
| `company.create` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `company.name.update` | all | own | own | — | — | — |
| `company.slug.update` | all | own | — | — | — | — |
| `company.avatar_url.update` | all | own | own | — | — | — |
| `company.delete` | all | own | — | — | — | — |

Reading the matrix: any authenticated user can create a company (and is
seated `owner`). A **company member** views their own company (whole
record) but mutates nothing. A **company admin** renames + reskins it. A
**company owner** also changes the slug, transfers, and deletes.
`company.view.all` (the global directory) is platform-admin reach; the
membership bundles see only the companies they hold a membership on —
the directory listing itself is served to everyone via `view.all`'s
list projection (see Notes).

---

## 3. Notes

- **The company list/directory is global, not scoped.** Everyone can
  list every company — the response carries `my_role` (null when not a
  member) so the FE knows which are actionable. In view-rooted terms the
  directory listing rides `company.view.all`'s list projection (breadth
  = every row, fields = directory-public only), while `company.view` at
  `own` reach gates the full record. Company discovery is open;
  *mutation* is membership-gated.

- **`company.delete` is owner-only.** Deleting CASCADEs memberships and
  SET NULLs `projects.company_id` (company projects survive as
  personal). It derives from `company.view.field.all`, but the bundle
  narrows it to `co:owner` + `plat:admin` — admins can't delete.

- **`company.slug.update` is owner-only.** The slug is in URLs; changing
  it is a higher-trust action than a rename, so it's narrower than
  `company.name.update` — `co:owner` + `plat:admin` only.

- **Company transfer + delete are owner-only.** Both are
  give-away-the-company actions, gated to `co:owner` + `plat:admin`.

- **Member management lives on [Membership](membership.md).** Adding,
  removing, and role-changing members mutate company-scope `memberships`
  rows — those atoms (`membership.create@company`, etc.) are specced
  there, with the last-owner guard + owner-only-for-granting-owner
  rules. Company's atoms are only about the company row.

- **Last-owner guard** (cross-ref): the company can't be left
  owner-less — enforced on the Membership side (`db::company_owner_count`),
  not via a Company atom.
