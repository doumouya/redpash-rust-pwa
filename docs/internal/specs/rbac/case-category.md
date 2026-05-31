---
title: CaseCategory — permission catalog
section: Internal
order: 58
last modified date: 2026-05-31
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# CaseCategory (CAT_) — permissions

Permission keys + default grant matrix for the CaseCategory object —
the two-level case-triage taxonomy. Derived from
[case-category metadata](../object-metadata/case-category.md); see the
[catalog template](index.md) for the key scheme + role tiers.

**View reaches CaseCategory supports:** `company_id` → `@company`
(per-company taxonomies, v3); platform admin → `@all`. Categories
belong to a company, so the row-breadth reaches are `company` and
`all` only (no `own` / `project`). `parent_id` is a self-FK (hierarchy,
not a reach). A NULL `company_id` is a **global / built-in** category
(seeded) — viewable by everyone. `@all` = platform admin.

**v1 reality: read-only.** Per the metadata, *none* of create / update
/ delete are exposed as user-facing endpoints today — categories are
seeded via migration and surfaced only through the flat `list` + the
hydrated `category_name` fields on Case. So the v1 catalog is
essentially the `case_category.view` atom; the write atoms are declared
for v3 (per-company taxonomy management) but ungranted to anyone but
platform admin until then.

---

## 1. Atoms

View-rooted (per [index](index.md#key-scheme)): `view` is the root,
writes derive from it. `list`/`search` are all `case_category.view` —
the reach decides *which* categories the list returns (global ∪
caller's company).

### View atoms

| Atom | Covers | Reach | Notes |
|---|---|---|---|
| `case_category.view` | the category (the flat taxonomy the case picker reads via `GET /api/cases/categories`) | company · all | global (NULL company) entries visible to all; company entries to members (v3). `list`/`search`/Case-hydration all gate on this |
| `case_category.view.all` | every category | all | platform admin |
| `case_category.view.field.<name>` | one field | inherits the row reach | **allow-list**, one per readable field: `name` · `parent` · `company`. Standard bundles hold `view.field.all`; *subsetting fields is a custom-role (v3) feature* |
| `case_category.view.field.all` | every field | company · all | the "see the whole record" atom; **required to delete** |

### Write atoms (derive from a view atom) — *all v3*

| Atom | Derives from | Reach | Notes |
|---|---|---|---|
| `case_category.create` | object `case_category.view` | — (no row yet) | **Not exposed in v1** (seed-script only). v3: per-company create. |
| `case_category.name.update` | `case_category.view.field.name` | company · all | **Not exposed in v1.** Rename a category. |
| `case_category.parent.update` | `case_category.view.field.parent` | company · all | **Not exposed in v1.** Reparent in the tree (hierarchy edit, not a reach change). |
| `case_category.delete` | `case_category.view.field.all` | company · all | **Not exposed in v1.** Delete CASCADEs children, SET NULLs `cases.category_id`. |

**No atoms for:** `redpash_id`, `created_at`, single-`read` (surfaced
via `view`/`list` + Case hydration, never individually addressed) —
auto / server-assigned. `company` is set at create and not separately
re-scoped in v1, so it mints no `*.update` atom.

---

## 2. Grant matrix

Default role-bundle → atom mapping. Cell = the **reach** the bundle
grants (or `—`). Columns: platform `admin`; the membership bundles
`owner`/`admin`/`member`/`viewer` at company reach; and `<obj>-mem` —
a bare object membership, which resolves at `own` (CaseCategory has no
`own` reach, so it never grants). Wider reach wins on union.

| Atom | plat:admin | co:owner | co:admin | co:member | co:viewer | cat-mem |
|---|---|---|---|---|---|---|
| `case_category.view` | all | company | company | company | company | — |
| `case_category.view.field.all` | all | company | company | company | company | — |
| `case_category.create` *(v3)* | ✓ | ✓ | ✓ | — | — | — |
| `case_category.name.update` *(v3)* | all | company | company | — | — | — |
| `case_category.parent.update` *(v3)* | all | company | company | — | — | — |
| `case_category.delete` *(v3)* | all | company | — | — | — | — |

Reading the matrix — v1: every company member **views** the taxonomy
(whole records; global entries always, their company's entries when
per-company lands); nobody but platform admin mutates (seed-only). v3
projection: company owner/admin curate their company's taxonomy;
**delete** needs `view.field.all` + the delete atom, narrowed to
owner-and-up (CASCADE is destructive).

---

## 3. Notes

- **Read-only taxonomy in v1.** The only live atom is
  `case_category.view`. The Monitoring **Categories tab** (epic
  CAS_9A0C, Torv frontend) surfaces this list read-only — exactly the
  v1 grant. The write atoms are catalogued now so the v3 per-company
  management UI has its target, but they grant to nobody except
  platform admin today.

- **Global vs company reach.** `company_id IS NULL` = built-in /
  global (everyone views); `company_id = CMP_…` = that company's
  private taxonomy (members view, v3). The `view` reach unions the
  caller-visible set; `@company` here means "global ∪ my-company's."

- **`parent_id` is hierarchy, not reach.** The self-FK builds the two-
  level tree; it never gates access. Reparenting (v3) is the
  `case_category.parent.update` field atom, derived from
  `case_category.view.field.parent` under the same admin grant as the
  other field updates.

- **Delete cascades down, SET NULLs sideways.** Deleting a parent
  CASCADEs its children but SET NULLs `cases.category_id` (cases
  survive uncategorised) — owner-only when the v3 delete path ships,
  and gated by `view.field.all` (see the whole record before destroying
  it).
