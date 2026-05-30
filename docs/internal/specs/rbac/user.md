---
title: User — permission catalog
section: Internal
order: 52
last modified date: 2026-05-30
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# User (USR_) — permissions

Permission keys + default grant matrix for the User object. Derived
from [user metadata](../object-metadata/user.md); scheme in the
[catalog template](index.md).

**Scope columns User carries:** none of its own — a User row isn't
company/project-scoped by an FK. `@own` = `redpash_id == caller` (the
user is themselves). `@company` is resolved indirectly: a company
admin sees users who share one of their `memberships` (company-typed
rows in the unified `memberships` table). `@all`
= platform admin. (No `@project` for User.)

User is planned to be the **platform-role source** — the tier that
grants `*@all`. There is **no `users.role` column today** (the closest
current column is `users.status` = active/suspended/archived); a
`role` column lands when role management ships. Editing `plan` / `role`
is billing/provisioning, held above the self tier.

---

## 1. Keys

### Object-action keys

| Key | Verb | Scopes | Notes |
|---|---|---|---|
| `user.create` | `POST /api/users` | — | Provisioning. Also the OAuth auto-upsert path (system-initiated, no caller grant). |
| `user.read` | `GET /api/users/:rid` | own · company · all | Self always; company admins see co-members; platform admin all. |
| `user.update` | `PATCH /api/users/:rid` | own · all | Coarse profile-update gate. |
| `user.delete` | `DELETE /api/users/:rid` | own · all | Self-deactivate (`@own`) or platform admin. |
| `user.list` | `GET /api/users` | company · all | Org inventory. Company admins see their members; platform admin all. |
| `user.search` | `GET /api/admin/users?q=…` | company · all | Granted with `list`. The `q=` search param lives only on the admin list endpoint — `GET /api/users` has no `q` param. |

### Field-update keys

| Key | Field | Scopes | Notes |
|---|---|---|---|
| `user.username.update` | `username` | own · all | Identity handle; self-editable (UNIQUE-guarded). |
| `user.email.update` | `email` | own · all | Self-editable. |
| `user.display_name.update` | `display_name` | own · all | |
| `user.first_name.update` | `first_name` | own · all | |
| `user.last_name.update` | `last_name` | own · all | |
| `user.avatar_url.update` | `avatar_url` | own · all | |
| `user.job_title.update` | `job_title` | own · all | |
| `user.organisation.update` | `organisation` | own · all | Free-text profile org (distinct from Company membership). |
| `user.use_case.update` | `use_case` | own · all | |
| `user.locale.update` | `locale` | own · all | |
| `user.plan.update` | `plan` | all | **Billing tier — platform-admin only.** A user can't upgrade their own plan from the profile; that routes through a billing flow (not the User PATCH) when it ships. |

**No keys for:** `redpash_id`, `role` (platform-role assignment is an
admin-provisioning concern, not a profile PATCH field — gets its own
`user.role.update@all` key only when role management ships),
`google_sub` (OAuth-managed), `created_at`.

---

## 2. Grant matrix

| Key | plat:admin | co:owner | co:admin | co:member | @own |
|---|---|---|---|---|---|
| `user.create` | ✓ | — | — | — | — |
| `user.read` | all | company | company | company | own |
| `user.list` | all | company | company | company | — |
| `user.search` | all | company | company | company | — |
| `user.update` | all | — | — | — | own |
| `user.delete` | all | — | — | — | own |
| `user.username.update` | all | — | — | — | own |
| `user.email.update` | all | — | — | — | own |
| `user.display_name.update` | all | — | — | — | own |
| `user.first_name.update` | all | — | — | — | own |
| `user.last_name.update` | all | — | — | — | own |
| `user.avatar_url.update` | all | — | — | — | own |
| `user.job_title.update` | all | — | — | — | own |
| `user.organisation.update` | all | — | — | — | own |
| `user.use_case.update` | all | — | — | — | own |
| `user.locale.update` | all | — | — | — | own |
| `user.plan.update` | all | — | — | — | — |

Reading it: a user owns their own profile (`@own` read + edit of every
profile field except `plan`); company owner/admin can read + list +
search the people in their company (the org-inventory Home tab) but
can't edit another user's profile; only platform admin edits across
users or touches `plan`.

---

## 3. Notes

- **`@own` is the user themselves.** Unlike row-owned objects, User's
  `@own` predicate is `target.redpash_id == caller`, not an
  `owner_id` column.

- **`@company` is membership-resolved, not column-scoped.** A company
  admin's `user.read@company` resolves to "users sharing a
  company membership with the caller's company." There's no
  `users.company_id` — the join is through the unified `memberships`
  table (company-typed rows).

- **`user.create` is mostly system-initiated.** The OAuth upsert
  creates users without any caller grant (the system acts). The
  explicit `POST /api/users` provisioning path is platform-admin only
  (dev-permissive today).

- **`plan` + `role` are deliberately not self-editable.** Both are
  privilege/billing escalation surfaces. `plan` gets `@all`-only here;
  `role` (platform-role assignment) is excluded entirely until a
  role-management surface ships with its own audited key.

- **Self-delete is account deactivation.** `user.delete@own` is the
  "delete my account" path; cascades follow the FKs (SET NULL on
  cases/projects per the metadata) so authored content survives.
