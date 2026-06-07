# `public.projects`

## Schema

<!-- doc-gen:schema:projects START — generated from the live DB; do not hand-edit -->
**Table `public.projects`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `redpash_id` | text | NO |  |
| 2 | `name` | text | NO |  |
| 3 | `description` | text | YES |  |
| 4 | `company_id` | text | YES |  |
| 5 | `status` | text | NO | `'draft'::text` |
| 6 | `created_at` | timestamp with time zone | NO | `now()` |
| 7 | `updated_at` | timestamp with time zone | NO | `now()` |

- **Primary key:** `PRIMARY KEY (redpash_id)`
- **Foreign keys:**
    - `projects_company_id_fkey` — FOREIGN KEY (company_id) REFERENCES companies(redpash_id) ON DELETE SET NULL
    - `projects_redpash_id_fkey` — FOREIGN KEY (redpash_id) REFERENCES entities(id) ON DELETE CASCADE
- **Checks:**
    - `projects_status_check` — CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])))
- **Indexes:**
    - `CREATE INDEX projects_company_idx ON public.projects USING btree (company_id)`
    - `CREATE UNIQUE INDEX projects_pkey ON public.projects USING btree (redpash_id)`
    - `CREATE INDEX projects_status_idx ON public.projects USING btree (status)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:projects END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
