---
title: CaseCategory — permission catalog
section: Internal
order: 58
last modified date: 2026-05-29
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# CaseCategory (CAT_) — permissions

Permission keys + default grant matrix for the CaseCategory object —
the two-level case-triage taxonomy. Derived from
[case-category metadata](../object-metadata/case-category.md); scheme
in the [catalog template](index.md).

**Scope columns CaseCategory carries:** `company_id` → `@company`
(per-company taxonomies, v3); `parent_id` is a self-FK (hierarchy, not
a scope). A NULL `company_id` is a **global / built-in** category
(seeded) — readable by everyone. `@all` = platform admin.

**v1 reality: read-only.** Per the metadata, *none* of create / read-
single / update / delete / search are exposed as user-facing endpoints
today — categories are seeded via migration and surfaced only through
the flat `list` + the hydrated `category_name` fields on Case. So the
v1 catalog is essentially one key (`case_category.list`); the mutation
keys are declared for v3 (per-company taxonomy management) but
ungranted to anyone but platform admin until then.

---

## 1. Keys

| Key | Verb | Scopes | Notes |
|---|---|---|---|
| `case_category.list` | `GET /api/cases/categories` | company · all | The flat taxonomy the case picker reads. Global (NULL company) entries visible to all; company entries to members (v3). |
| `case_category.create` | — *(v3)* | company · all | **Not exposed in v1** (seed-script only). v3: per-company create. |
| `case_category.update` | — *(v3)* | company · all | **Not exposed in v1.** Rename / reparent. |
| `case_category.delete` | — *(v3)* | company · all | **Not exposed in v1.** Delete CASCADEs children, SET NULLs `cases.category_id`. |

**No field-update keys in v1** — `name` / `parent_id` / `company_id`
aren't user-editable yet (seed-managed). They'd mint
`case_category.name.update` / `.parent_id.update` when the v3 mutation
paths land. **No keys for:** `redpash_id`, `created_at`, single-`read`
(surfaced via `list` + Case hydration, never individually addressed).

---

## 2. Grant matrix

| Key | plat:admin | co:owner | co:admin | co:member |
|---|---|---|---|---|
| `case_category.list` | all | company | company | company |
| `case_category.create` *(v3)* | all | company | company | — |
| `case_category.update` *(v3)* | all | company | company | — |
| `case_category.delete` *(v3)* | all | company | — | — |

v1: every member can `list` the taxonomy (global entries always; their
company's entries when per-company lands); nobody but platform admin
mutates (seed-only). v3 projection: company owner/admin curate their
company's taxonomy; delete narrows to owner (CASCADE is destructive).

---

## 3. Notes

- **Read-only taxonomy in v1.** The only live key is
  `case_category.list`. The Monitoring **Categories tab** (epic
  CAS_9A0C, Torv frontend) surfaces this list read-only — exactly the
  v1 grant. The mutation keys are catalogued now so the v3 per-company
  management UI has its target, but they grant to nobody except
  platform admin today.

- **Global vs company scope.** `company_id IS NULL` = built-in /
  global (everyone reads); `company_id = CMP_…` = that company's
  private taxonomy (members read, v3). The `list` endpoint unions the
  caller-visible set; `@company` here means "global ∪ my-company's."

- **`parent_id` is hierarchy, not scope.** The self-FK builds the two-
  level tree; it never gates access. Reparenting (v3) is a
  `case_category.parent_id.update` field key under the same admin
  grant as `update`.

- **Delete cascades down, SET NULLs sideways.** Deleting a parent
  CASCADEs its children but SET NULLs `cases.category_id` (cases
  survive uncategorised) — owner-only when the v3 delete path ships.
