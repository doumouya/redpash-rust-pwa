---
title: CaseCategory — object metadata
section: Internal
order: 48
last modified date: 2026-05-30
owner: Torv
status: draft — per the object-metadata sweep ([index](index.md))
---

# CaseCategory (CAT_)

A two-level taxonomy tag for Cases. Cases pick a leaf (subcategory)
or a parent directly when no fit exists; v1 ships a seeded set of
globals (built-in taxonomy) and a per-company-customisation path
gated by RBAC in v3.

**Backing table:** `case_categories` (migration
`20260612000001_case_categories.sql`, ord 030).
**DTO:** `backend/crates/shared/src/case.rs` (`Category`).
**Routes:** `backend/crates/api/src/routes/cases.rs` — only the
`GET /api/cases/categories` list is exposed today; create / update /
delete are admin / seed-script paths (no user-facing CRUD endpoints
in v1).

---

## Supported calls

| Verb | Wire | Notes |
|---|---|---|
| `create` | — | **Not exposed as a user-facing endpoint in v1.** Categories are seeded via migration / admin script. v3 will add a per-company create path when RBAC ships. |
| `read` | — | **Not exposed individually.** Categories are surfaced only via the list endpoint + via the hydrated `category_name` / `category_parent_id` / `category_parent_name` fields on Case. |
| `update` | — | **Not exposed.** Renames + reparents are admin / seed-script paths in v1. |
| `delete` | — | **Not exposed.** Delete-via-migration would CASCADE children (parent → children FK is ON DELETE CASCADE) but SET NULL on `cases.category_id` (cases become uncategorised, not deleted). |
| `list` | `GET /api/cases/categories` | Returns the flat list of categories the caller can pick from. v1 returns the global set (company_id IS NULL); v3 RBAC overlay will union the caller's company-scoped categories on top. Both parents and children come back in one array; the FE groups by `parent_id` to build the hierarchical picker (roots → subcategories). |
| `search` | — | **Not supported.** Picker UX filters client-side over the flat list — small enough that no server filter is justified. |

---

## Fields

```
redpash_id
  Type:        TEXT / String — format CAT_<32 uppercase hex>
  Properties:  (none — internal)
  Description: Primary key. Server-assigned via id::new("CAT") on
               the seed-script / future-admin-create path. The
               cases.category_id FK targets this column.
```

```
name
  Type:        TEXT NOT NULL / String
  Properties:  (none — not currently writable from user-facing
                routes; seed-script only)
  Description: Display name. Uniqueness is enforced by two partial
               unique indexes split on whether the row is a root or
               a child:
                 - `case_categories_root_uq ON (name,
                   COALESCE(company_id,'')) WHERE parent_id IS NULL`
                 - `case_categories_child_uq ON (parent_id, name,
                   COALESCE(company_id,'')) WHERE parent_id IS NOT NULL`
               COALESCE applies only to the nullable `company_id`;
               the NULL/non-NULL `parent_id` cases are separated by
               each index's partial WHERE. So two roots can both be
               named "Backend" only if one is global and the other
               is company-scoped.
```

```
parent_id
  Type:        TEXT / Option<String> — self-FK to case_categories.redpash_id
  Properties:  Nillable
  Description: Hierarchy parent. NULL = root category. CASCADE on
               parent delete (removing a parent collapses its
               children). The two-level limit isn't enforced by
               the schema — parent_id COULD point at another
               child — but the picker UI assumes flat parent →
               subcategory.
```

```
company_id
  Type:        TEXT / Option<String> — FK to companies.redpash_id
  Properties:  Nillable
  Description: Scoping. NULL = global / built-in (the seeded
               v1 set). Non-null = per-company customisation
               (v3 path; not user-creatable today). CASCADE on
               company delete: company-scoped categories drop
               with the company; cases that referenced them go
               uncategorised (cases.category_id is SET NULL on
               category delete).
```

```
created_at
  Type:        TIMESTAMPTZ NOT NULL DEFAULT now() / chrono::DateTime<Utc>
  Properties:  (none — internal)
  Description: Auto-set on INSERT. Not surfaced on the picker UI.
```

Note: **no `updated_at` column** on `case_categories` — categories
are effectively immutable in v1 (seed-only). When v3 adds an update
path, the column gets added in that migration.

---

## Enum constraints

None on `case_categories` itself — `name` is free-text, both
nullable refs are FKs validated at the schema layer.

Implicit hierarchy rule: a category is a **root** when `parent_id
IS NULL` and a **subcategory** otherwise. The FE picker enforces
the two-level cap (no grandchildren) by hiding the "Add subcategory"
affordance under any non-root entry.

Implicit scope rule: a category is **global** when `company_id IS
NULL` and **company-scoped** otherwise. v1 returns globals only;
v3 unions in the caller's company-scoped customisations.

---

## Relationships

```
parent_id → CaseCategory (CAT_, self-FK)
  Cardinality:  N:1 (a parent category has many subcategories)
  On delete:    CASCADE (deleting a parent removes its children)
  Hydrated as:  — (the parent appears as its own row in the same
                list payload; FE walks the parent_id reference
                to build the picker hierarchy)
```

```
company_id → Company (CMP_)
  Cardinality:  N:1
  On delete:    CASCADE (company-scoped categories drop with the
                company; v3 RBAC visibility folds in here)
  Hydrated as:  — (not back-joined; company affiliation surfaced
                as the FK only)
```

### Inverse relationships

```
CaseCategory is referenced by Cases
  Backing:       cases.category_id (mig 030 ALTER TABLE)
  Cardinality:   1:N (one category tags many cases)
  On delete:     SET NULL on cases.category_id (deleting a
                 category un-tags its cases; the cases survive)
  Hydrated as:   category_name + category_parent_id + category_parent_name
                 on the Case DTO. See [case](case.md#fields).
```

---

## Audit events

None. Category mutations (create / update / delete) aren't
user-triggered in v1 — they happen via migration or seed script,
which don't go through `crate::event::record`. v3 RBAC-gated
admin create will add `case_category_create` + `_update` + `_delete`
kinds when those paths land.

Cases that change their category emit `case_category_change` —
that's a Case event, not a CaseCategory event. See
[case](case.md#audit-events).
