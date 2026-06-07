# `public.case_categories`

## Schema

<!-- doc-gen:schema:case_categories START — generated from the live DB; do not hand-edit -->
**Table `public.case_categories`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `redpash_id` | text | NO |  |
| 2 | `parent_id` | text | YES |  |
| 3 | `name` | text | NO |  |
| 4 | `company_id` | text | YES |  |
| 5 | `created_at` | timestamp with time zone | NO | `now()` |

- **Primary key:** `PRIMARY KEY (redpash_id)`
- **Foreign keys:**
    - `case_categories_company_id_fkey` — FOREIGN KEY (company_id) REFERENCES companies(redpash_id) ON DELETE CASCADE
    - `case_categories_parent_id_fkey` — FOREIGN KEY (parent_id) REFERENCES case_categories(redpash_id) ON DELETE CASCADE
- **Indexes:**
    - `CREATE UNIQUE INDEX case_categories_child_uq ON public.case_categories USING btree (parent_id, name, COALESCE(company_id, ''::text)) WHERE (parent_id IS NOT NULL)`
    - `CREATE INDEX case_categories_company_idx ON public.case_categories USING btree (company_id) WHERE (company_id IS NOT NULL)`
    - `CREATE INDEX case_categories_parent_idx ON public.case_categories USING btree (parent_id)`
    - `CREATE UNIQUE INDEX case_categories_pkey ON public.case_categories USING btree (redpash_id)`
    - `CREATE UNIQUE INDEX case_categories_root_uq ON public.case_categories USING btree (name, COALESCE(company_id, ''::text)) WHERE (parent_id IS NULL)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:case_categories END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
