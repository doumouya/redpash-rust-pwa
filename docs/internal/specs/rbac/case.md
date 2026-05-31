---
title: Case — permission catalog
section: Internal
order: 51
last modified date: 2026-05-31
owner: Torv
status: pattern-lock — first worked example of the RBAC catalog template ([index](index.md))
---

# Case (CAS_) — permissions

Permission keys + default grant matrix for the Case object. Derived
from [case metadata](../object-metadata/case.md); see the
[catalog template](index.md) for the key scheme + role tiers.

**Scope columns Case carries:** `reporter_id` + `assignee_id` →
`@own`; `project_id` → `@project`; `company_id` → `@company`; platform
admin → `@all`. All four scope qualifiers apply.

> Post-[entity-membership-model](entity-membership-model.md):
> `reporter_id`/`assignee_id` are **derived**, not columns — they
> resolve from `memberships` (`context_role` = 'Reporter' / 'Case
> Owner', `member_redpash_id` = the holder). The widened key allows a
> case to have co-reporters and one person to be both; the API exposes
> a single derived value per slot today (the co-reporter shape is an
> open decision in the model spec §6).

**`@own` predicate for Case is two-pronged:** a row is "own" when
`reporter_id == caller` **OR** `assignee_id == caller`. The reporter
filed it; the assignee works it — both have an ownership stake. (Most
objects have a single `@own` column; Case is the first with two. Noted
here because the enforcement layer's `@own` check for Case is an `OR`,
not the usual single-column equality.)

---

## 1. Keys

### Object-action keys (from [Supported calls](../object-metadata/case.md#supported-calls))

| Key | Verb | Scopes | Notes |
|---|---|---|---|
| `case.create` | `POST /api/cases` | — | All-or-nothing over the create body. `reporter_id` forced to caller; `status` seeded `backlog` server-side. No scope: creating a row you don't own yet. |
| `case.read` | `GET /api/cases/:rid` | own · project · company · all | Returns the `CaseDetail` envelope (case + comments + activity). |
| `case.update` | `PATCH /api/cases/:rid` | own · project · company · all | Coarse update gate. A holder of this implicitly holds every field-update key below. |
| `case.delete` | `DELETE /api/cases/:rid` | company · all | Destructive; comments CASCADE. Deliberately NOT grantable `@own` — see Notes. |
| `case.list` | `GET /api/cases?…` | own · project · company · all | Paginated. The scope bounds *which* rows the list returns. |
| `case.search` | `GET /api/cases?q=…` | own · project · company · all | ILIKE on title + description. Granted with `list`. |

### Field-update keys (from `Update`-property fields)

Every Case field carrying the `Update` property → one fine-grained key.
A role with the coarse `case.update` holds all of these; a role can
instead be granted a subset.

| Key | Field | Scopes | Notes |
|---|---|---|---|
| `case.type.update` | `type` | company · all | Triage classification (bug/feature/task/epic). |
| `case.title.update` | `title` | own · company · all | Reporter can retitle their own case. |
| `case.description.update` | `description` | own · company · all | Reporter edits their own body. |
| `case.status.update` | `status` | own · project · company · all | The workflow verb — assignee advances their own case; members advance company cases. |
| `case.priority.update` | `priority` | company · all | Triage decision — narrower than status. |
| `case.assignee.update` | `assignee_id` | own · company · all | Reassign. `@own` lets the assignee hand off; `@company` lets admins assign. |
| `case.project.update` | `project_id` | company · all | Re-scoping a case to a project. |
| `case.company.update` | `company_id` | company · all | Re-scoping a case to a company — admin-level. |
| `case.error_message.update` | `error_message` | own · company · all | Raw error payload (auto-triaged cases); reporter/admin only. |
| `case.category.update` | `category_id` | company · all | Taxonomy tag — triage decision. |

**No keys for:** `redpash_id`, `reporter_id` (server-forced to caller),
`status`-on-create (seeded server-side), `created_at`, `updated_at`,
and the hydrated read-only fields (`reporter_display_name`,
`assignee_display_name`, `category_name`, …) — they carry no
Create/Update property in the metadata.

---

## 2. Grant matrix

Default policy. Cell = the **widest scope** that role holds for the
key, or `—` for no grant. Columns: platform `admin`; company
`owner`/`admin`/`member`; project `collab`/`viewer` (v3, inert today);
`@own` (reporter-or-assignee, independent of membership). Anonymous
callers hold nothing (omitted — see Notes).

| Key | plat:admin | co:owner | co:admin | co:member | proj:collab | proj:viewer | @own |
|---|---|---|---|---|---|---|---|
| `case.create` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `case.read` | all | company | company | company | project | project | own |
| `case.list` | all | company | company | company | project | project | own |
| `case.search` | all | company | company | company | project | project | own |
| `case.update` | all | company | company | — | project | — | own |
| `case.delete` | all | company | company | — | — | — | — |
| `case.type.update` | all | company | company | — | project | — | — |
| `case.title.update` | all | company | company | — | project | — | own |
| `case.description.update` | all | company | company | — | project | — | own |
| `case.status.update` | all | company | company | company | project | — | own |
| `case.priority.update` | all | company | company | — | project | — | — |
| `case.assignee.update` | all | company | company | — | project | — | own |
| `case.project.update` | all | company | company | — | — | — | — |
| `case.company.update` | all | company | — | — | — | — | — |
| `case.error_message.update` | all | company | company | — | — | — | own |
| `case.category.update` | all | company | company | — | project | — | — |

Reading the matrix: a **company member** can create cases, read/list/
search every case in their company, and advance the `status` of any
company case (the collaborative kanban flow) — but can't reassign,
reprioritize, re-scope, or delete. A **reporter/assignee** (`@own`)
can read + edit their own case's title/description/status/assignee/
error_message even with no company membership. A **company admin** has
full field control over company cases except transferring the case to
another company (`case.company.update` — owner-only). **Delete** is
admin-and-up only, never `@own`.

---

## 3. Notes

- **`case.delete` is never `@own`.** A reporter can't delete their own
  case — deletion CASCADEs the comment thread and is irreversible.
  Closing a case is `status → done` (a `case.status.update`), not a
  delete. Delete is an admin janitorial action (`co:admin+` /
  `plat:admin`).

- **Two-column `@own`.** Enforcement's `@own` check for Case is
  `reporter_id == caller OR assignee_id == caller`. The widest-scope
  resolution still applies: a company admin who is also the assignee
  resolves at `@company` (wider), so the `@own`-only field restrictions
  don't bind them.

- **`case.company.update` is owner-only at the company tier.** Moving a
  case *out* of a company is effectively giving it away — gated to
  `co:owner` + `plat:admin`. Company admins can re-scope to a
  *project* (`case.project.update`) but not change the company.

- **Create forces three fields server-side.** `reporter_id` (caller),
  `status` (`backlog`), and the `CAS_` rid are never client-settable —
  so `case.create` covers the *settable* create-body fields only
  (`type` / `title` / `description` / `priority` / `assignee_id` /
  `project_id` / `company_id` / `error_message` / `category_id`). No
  field-create keys (per the [index](index.md#field-update-keys)
  all-or-nothing-create rule).

- **Activity events are read-gated with the case.** The `activity[]`
  feed in the `CaseDetail` response is the `events.kind=case_*` rows
  for that case; seeing them is covered by `case.read` (no separate
  `case.activity.read` key). Cross-case event browsing on the
  Monitoring surface is gated by the Event object's keys, not Case's.

- **Today everything resolves `@all`.** Dev-permissive: `resolve_user_rid`
  yields the dev_user, which the enforcement layer will treat as
  `plat:admin` until real platform roles ship. This matrix is the
  target the enforcement slice checks against — it changes no runtime
  behavior on its own.
