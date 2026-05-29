---
title: Company — permission catalog
section: Internal
order: 53
last modified date: 2026-05-29
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# Company (CMP_) — permissions

Permission keys + default grant matrix for the Company object. Derived
from [company metadata](../object-metadata/company.md); scheme in the
[catalog template](index.md).

**Scope columns Company carries:** Company IS the company-scope root —
its own `redpash_id` is what `@company` resolves against. `@own` here
means "a company the caller is a member of" (via `company_memberships`);
`@all` = platform admin. No `@project`. Company is also the
**company-role source** (`company_memberships.role` — owner/admin/member).

Member-management calls (add/remove/role-change) are specced on the
[Membership](membership.md) object since the membership row is the
mutated entity; Company's keys cover the company row itself.

---

## 1. Keys

### Object-action keys

| Key | Verb | Scopes | Notes |
|---|---|---|---|
| `company.create` | `POST /api/companies` | — | Creator seated as `owner` in one TX. Any authenticated user. |
| `company.read` | `GET /api/companies/:rid` | own · all | Members read their company; platform admin all. |
| `company.update` | `PATCH /api/companies/:rid` | own · all | Coarse update; owner/admin per field below. |
| `company.delete` | `DELETE /api/companies/:rid` | own · all | Owner-only at the company tier (projects SET NULL, memberships CASCADE). |
| `company.list` | `GET /api/companies` | all | Returns every company with the caller's `my_role` (null when not a member). The list is global; membership decides what's actionable, not what's listed. |
| `company.search` | `GET /api/companies?q=…` | all | Granted with `list`. |

### Field-update keys

| Key | Field | Scopes | Notes |
|---|---|---|---|
| `company.name.update` | `name` | own · all | Owner/admin rename. |
| `company.slug.update` | `slug` | own · all | URL slug; owner-only (changing it breaks links). |
| `company.avatar_url.update` | `avatar_url` | own · all | Owner/admin. |

**No keys for:** `redpash_id`, `owner_id`-equivalent (ownership lives
in `company_memberships.role = owner`, not a column on companies),
`created_at`.

---

## 2. Grant matrix

| Key | plat:admin | co:owner | co:admin | co:member |
|---|---|---|---|---|
| `company.create` | ✓ | ✓ | ✓ | ✓ |
| `company.read` | all | own | own | own |
| `company.list` | all | all | all | all |
| `company.search` | all | all | all | all |
| `company.update` | all | own | own | — |
| `company.delete` | all | own | — | — |
| `company.name.update` | all | own | own | — |
| `company.slug.update` | all | own | — | — |
| `company.avatar_url.update` | all | own | own | — |

`co:owner`/`co:admin`/`co:member` columns here mean "the caller's role
*in the company being acted on*" — `own` scope is implicit (you act on
a company you belong to). Reading it: any user can create a company
(and is seated owner); members read their own company; admins rename +
reskin it; only the owner changes the slug, transfers, or deletes.

---

## 3. Notes

- **`company.list` is global, not scoped.** Everyone can list every
  company (the directory) — the response carries `my_role` (null when
  not a member) so the FE knows which are actionable. This is
  deliberate: company discovery is open; *mutation* is membership-gated.

- **`company.delete` is owner-only.** Deleting CASCADEs memberships and
  SET NULLs `projects.company_id` (company projects survive as
  personal). Admins can't delete — only the owner or platform admin.

- **`company.slug.update` is owner-only.** The slug is in URLs; changing
  it is a higher-trust action than a rename, so it's narrower than
  `company.name.update`.

- **Member management lives on [Membership](membership.md).** Adding,
  removing, and role-changing members mutate `company_memberships`
  rows — those keys (`membership.create@company`, etc.) are specced
  there, with the last-owner guard + owner-only-for-granting-owner
  rules. Company's keys are only about the company row.

- **Last-owner guard** (cross-ref): the company can't be left
  owner-less — enforced on the Membership side (`db::company_owner_count`),
  not via a Company key.
