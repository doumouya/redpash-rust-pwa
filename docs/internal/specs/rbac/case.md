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

## 1. Atoms

View-rooted (per [index](index.md#key-scheme)): `view` is the root,
writes derive from it. `read`/`list`/`search` are all `case.view` — the
reach decides *which* cases the list returns.

### View atoms

| Atom | Covers | Reach | Notes |
|---|---|---|---|
| `case.view` | the case (detail / list / search + the `activity[]` feed) | own · project · company · all | `own` = the caller holds a case membership (reporter / assignee / case-team) |
| `case.view.all` | every case | all | platform admin |
| `case.view.field.<name>` | one field | inherits the row reach | **allow-list**, one per readable field: `type` · `title` · `description` · `status` · `priority` · `assignee` · `project` · `company` · `error_message` · `category` (+ read-only `reporter`/`assignee` names, `created_at`, …). Standard bundles hold `view.field.all`; *subsetting fields is a custom-role (v3) feature* |
| `case.view.field.all` | every field | own · project · company · all | the "see the whole record" atom; **required to delete** |

### Write atoms (derive from a view atom)

| Atom | Derives from | Reach | Notes |
|---|---|---|---|
| `case.create` | object `case.view` | — (no row yet) | all-or-nothing body; `reporter_id` forced to caller, `status` seeded `backlog` |
| `case.title.update` | `case.view.field.title` | own · company · all | reporter retitles own case |
| `case.description.update` | `…field.description` | own · company · all | reporter edits own body |
| `case.status.update` | `…field.status` | own · project · company · all | kanban workflow — assignee advances own; members advance company cases |
| `case.assignee.update` | `…field.assignee` | own · company · all | `own` = hand-off; `company` = admin assign |
| `case.priority.update` | `…field.priority` | company · all | triage |
| `case.type.update` | `…field.type` | company · all | triage classification |
| `case.project.update` | `…field.project` | company · all | re-scope to a project |
| `case.company.update` | `…field.company` | company · all (**owner-only**) | re-scope to a company — see Notes |
| `case.error_message.update` | `…field.error_message` | own · company · all | raw auto-triage payload |
| `case.category.update` | `…field.category` | company · all | taxonomy tag |
| `case.delete` | `case.view.field.all` | company · all | never `@own` — see Notes |

**No atoms for:** `redpash_id`, `reporter_id` (server-forced),
`created_at`, `updated_at` — auto / server-assigned.

---

## 2. Grant matrix

Default role-bundle → atom mapping. Cell = the **reach** the bundle
grants (or `—`). Columns: platform `admin`; the membership bundles
`owner`/`admin`/`member`/`viewer` at company reach; and `case-mem` —
a bare case membership (reporter/assignee/case-team, no company role),
which resolves at `own`. Wider reach wins on union.

| Atom | plat:admin | co:owner | co:admin | co:member | co:viewer | case-mem |
|---|---|---|---|---|---|---|
| `case.view` | all | company | company | company | company | own |
| `case.view.field.all` | all | company | company | company | company | own |
| `case.create` | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `case.title.update` | all | company | company | — | — | own |
| `case.description.update` | all | company | company | — | — | own |
| `case.status.update` | all | company | company | company | — | own |
| `case.assignee.update` | all | company | company | — | — | own |
| `case.priority.update` | all | company | company | — | — | — |
| `case.type.update` | all | company | company | — | — | — |
| `case.project.update` | all | company | company | — | — | — |
| `case.company.update` | all | company | — | — | — | — |
| `case.error_message.update` | all | company | company | — | — | own |
| `case.category.update` | all | company | company | — | — | — |
| `case.delete` | all | company | company | — | — | — |

Reading the matrix: a **company member** views every case in their
company (whole records) and advances `status` on the collaborative
kanban — but can't reassign / reprioritize / re-scope / delete. A bare
**case member** (reporter or assignee, no company role) views *their*
case fully and edits its title/description/status/assignee/error — the
`own` reach, granted by the case membership itself. A **company admin**
has full field control over company cases except transferring to
another company (`case.company.update` — owner-only). **Delete** needs
`view.field.all` + the delete atom: admin-and-up, never `case-mem`.

---

## 3. Notes

- **`case.delete` is never `@own`.** A reporter can't delete their own
  case — deletion CASCADEs the comment thread and is irreversible.
  Closing a case is `status → done` (a `case.status.update`), not a
  delete. Delete is an admin janitorial action (`co:admin+` /
  `plat:admin`).

- **`own` = a case membership (reporter *or* assignee).** The `own`
  reach resolves when the caller holds *any* membership edge on the case
  — `context_role` 'Reporter' or 'Case Owner' (the derived
  `reporter_id`/`assignee_id`). Both are case memberships, so the check
  is "∃ a `memberships` row `(object=case, member=caller)`", and the
  widened key means one caller can be both, or there can be co-reporters.
  Widest reach still wins: a company admin who is also the assignee
  resolves at `company`, so the `own`-only field limits don't bind them.

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

- **Activity events are view-gated with the case.** The `activity[]`
  feed in the `CaseDetail` response is the `events.kind=case_*` rows
  for that case; seeing them is covered by `case.view` (no separate
  activity atom). Cross-case event browsing on the Monitoring surface
  is gated by the Event object's atoms, not Case's.

- **Today everything resolves `@all`.** Dev-permissive: `resolve_user_rid`
  yields the dev_user, which the enforcement layer will treat as
  `plat:admin` until real platform roles ship. This matrix is the
  target the enforcement slice checks against — it changes no runtime
  behavior on its own.
