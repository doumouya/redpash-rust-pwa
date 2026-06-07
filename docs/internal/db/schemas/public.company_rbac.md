# `public.company_rbac`

## Schema

<!-- doc-gen:schema:company_rbac START — generated from the live DB; do not hand-edit -->
**Table `public.company_rbac`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `company_id` | text | NO |  |
| 2 | `version` | integer | NO |  |
| 3 | `contract` | jsonb | NO |  |
| 4 | `created_by` | text | YES |  |
| 5 | `created_at` | timestamp with time zone | NO | `now()` |

- **Primary key:** `PRIMARY KEY (company_id, version)`
- **Foreign keys:**
    - `company_rbac_company_id_fkey` — FOREIGN KEY (company_id) REFERENCES companies(redpash_id) ON DELETE CASCADE
    - `company_rbac_created_by_fkey` — FOREIGN KEY (created_by) REFERENCES users(redpash_id)
- **Indexes:**
    - `CREATE INDEX company_rbac_active ON public.company_rbac USING btree (company_id, version DESC)`
    - `CREATE UNIQUE INDEX company_rbac_pkey ON public.company_rbac USING btree (company_id, version)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:company_rbac END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
