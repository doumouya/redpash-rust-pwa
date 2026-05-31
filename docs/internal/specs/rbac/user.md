---
title: User — permission catalog
section: Internal
order: 52
last modified date: 2026-05-31
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# User (USR_) — permissions

Permission keys + default grant matrix for the User object. Derived
from [user metadata](../object-metadata/user.md); see the
[catalog template](index.md) for the key scheme + role tiers.

**View reaches User supports:** a User row carries no scope FK of its
own — it isn't a company/project-scoped row. `own` = the caller views
their **own profile** (`redpash_id == caller`); `all` = the admin user
directory (platform admin). There is **no `company`/`project` reach on
the User row itself** — Users are not company/project-scoped rows.

User is planned to be the **platform-role source** — the tier that
grants `*.view.all`. There is **no `users.role` column today** (the
closest current column is `users.status` = active/suspended/archived); a
`role` column lands when role management ships. Editing `plan` / `role`
is billing/provisioning, held above the self tier.

---

## 1. Atoms

View-rooted (per [index](index.md#key-scheme)): `view` is the root,
writes derive from it. `read`/`list`/`search` are all `user.view` — the
reach decides *which* users the list returns (your own profile at `own`;
the whole directory at `all`).

### View atoms

| Atom | Covers | Reach | Notes |
|---|---|---|---|
| `user.view` | the user (own profile / detail / list / search) | own · all | `own` = the caller views their own profile (`redpash_id == caller`); `read`/`list`/`search` all gate on this |
| `user.view.all` | every user | all | platform admin — the admin user directory |
| `user.view.field.<name>` | one field | inherits the row reach | **allow-list**, one per readable field: `username` · `email` · `display_name` · `first_name` · `last_name` · `avatar_url` · `job_title` · `organisation` · `use_case` · `locale` · `plan` (+ read-only `status`, `created_at`). Standard bundles hold `view.field.all`; *subsetting fields is a custom-role (v3) feature* |
| `user.view.field.all` | every field | own · all | the "see the whole record" atom; **required to delete** |

### Write atoms (derive from a view atom)

| Atom | Derives from | Reach | Notes |
|---|---|---|---|
| `user.create` | object `user.view` | — (no row yet) | provisioning; also the OAuth auto-upsert path (system-initiated, no caller grant) |
| `user.username.update` | `user.view.field.username` | own · all | identity handle; self-editable (UNIQUE-guarded) |
| `user.email.update` | `…field.email` | own · all | self-editable |
| `user.display_name.update` | `…field.display_name` | own · all | |
| `user.first_name.update` | `…field.first_name` | own · all | |
| `user.last_name.update` | `…field.last_name` | own · all | |
| `user.avatar_url.update` | `…field.avatar_url` | own · all | |
| `user.job_title.update` | `…field.job_title` | own · all | |
| `user.organisation.update` | `…field.organisation` | own · all | free-text profile org (distinct from Company membership) |
| `user.use_case.update` | `…field.use_case` | own · all | |
| `user.locale.update` | `…field.locale` | own · all | |
| `user.plan.update` | `…field.plan` | all | **billing tier — platform-admin only.** A user can't upgrade their own plan from the profile; that routes through a billing flow (not the User PATCH) when it ships |
| `user.delete` | `user.view.field.all` | own · all | self-deactivate (`own`) or platform admin — the scrub-retain tombstone (`status='archived'`), not a hard delete; see Notes |

**No atoms for:** `redpash_id` (the User's own identity column),
`role` (platform-role assignment is an admin-provisioning concern, not a
profile PATCH field — gets its own `user.role.update` at `all` only when
role management ships), `google_sub` (OAuth-managed), `created_at` —
auto / server-assigned.

---

## 2. Grant matrix

Default role-bundle → atom mapping. Cell = the **reach** the bundle
grants (or `—`). Columns: platform `admin`; the membership bundles
`owner`/`admin`/`member`/`viewer` at company reach; and `user-mem` — a
bare User membership (the user themselves, no company role), which
resolves at `own`. Wider reach wins on union.

| Atom | plat:admin | co:owner | co:admin | co:member | co:viewer | user-mem |
|---|---|---|---|---|---|---|
| `user.view` | all | company | company | company | company | own |
| `user.view.field.all` | all | company | company | company | company | own |
| `user.create` | ✓ | — | — | — | — | — |
| `user.username.update` | all | — | — | — | — | own |
| `user.email.update` | all | — | — | — | — | own |
| `user.display_name.update` | all | — | — | — | — | own |
| `user.first_name.update` | all | — | — | — | — | own |
| `user.last_name.update` | all | — | — | — | — | own |
| `user.avatar_url.update` | all | — | — | — | — | own |
| `user.job_title.update` | all | — | — | — | — | own |
| `user.organisation.update` | all | — | — | — | — | own |
| `user.use_case.update` | all | — | — | — | — | own |
| `user.locale.update` | all | — | — | — | — | own |
| `user.plan.update` | all | — | — | — | — | — |
| `user.delete` | all | — | — | — | — | own |

Reading it: a user owns their own profile (the `own` reach, whole record
via `view.field.all`, and edit of every profile field except `plan`); a
company owner/admin/member can view + list + search the people sharing
their company (the org-inventory Home tab, resolved through the unified
`memberships` table — see Notes) but can't edit another user's profile;
only platform admin views across the whole directory, edits across
users, or touches `plan`.

---

## 3. Notes

- **`own` is the user themselves.** Unlike row-owned objects, User's
  `own` reach resolves when `target.redpash_id == caller`, not via an
  `owner_id` column or a membership edge. The User's own
  `user_redpash_id` IS its identity column, not a membership reference.

- **`company` reach is membership-resolved, not column-scoped.** A
  company owner/admin's `user.view@company` resolves to "users sharing a
  company membership with the caller's company." There's no
  `users.company_id` — the join is through the unified `memberships`
  table (company-typed rows, subject column `member_redpash_id`). This
  is a reach *onto* the User directory granted by the caller's company
  membership; the User row itself carries no company FK.

- **`user.create` is mostly system-initiated.** The OAuth upsert creates
  users without any caller grant (the system acts). The explicit `POST
  /api/users` provisioning path is platform-admin only (dev-permissive
  today).

- **`plan` + `role` are deliberately not self-editable.** Both are
  privilege/billing escalation surfaces. `plan.update` gets `all`-only
  here; `role` (platform-role assignment) is excluded entirely until a
  role-management surface ships with its own audited atom.

- **`user.delete@own` is the scrub-retain tombstone, not a hard delete.**
  The "delete my account" path sets `status='archived'` (tombstone PII in
  place); all authored content survives (FK SET NULL on cases/projects
  per the metadata). Deletion requires `view.field.all` (the
  "see the whole record" atom) — held at `own` (self) and `all`
  (platform admin). There is no user-initiated hard delete.

- **Today everything resolves `all`.** Dev-permissive: `resolve_user_rid`
  yields the dev_user, which the enforcement layer will treat as
  `plat:admin` until real platform roles ship. This matrix is the target
  the enforcement slice checks against — it changes no runtime behavior
  on its own.
