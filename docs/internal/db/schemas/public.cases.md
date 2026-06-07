# `public.cases`

## Schema

<!-- doc-gen:schema:cases START — generated from the live DB; do not hand-edit -->
**Table `public.cases`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `redpash_id` | text | NO |  |
| 2 | `type` | text | NO | `'task'::text` |
| 3 | `title` | text | NO |  |
| 4 | `description` | text | YES |  |
| 5 | `status` | text | NO | `'backlog'::text` |
| 6 | `priority` | text | NO | `'medium'::text` |
| 7 | `project_id` | text | YES |  |
| 8 | `company_id` | text | YES |  |
| 9 | `category_id` | text | YES |  |
| 10 | `error_message` | text | YES |  |
| 11 | `created_at` | timestamp with time zone | NO | `now()` |
| 12 | `updated_at` | timestamp with time zone | NO | `now()` |
| 13 | `attachments` | jsonb | NO | `'[]'::jsonb` |

- **Primary key:** `PRIMARY KEY (redpash_id)`
- **Foreign keys:**
    - `cases_category_id_fkey` — FOREIGN KEY (category_id) REFERENCES case_categories(redpash_id) ON DELETE SET NULL
    - `cases_company_id_fkey` — FOREIGN KEY (company_id) REFERENCES companies(redpash_id) ON DELETE SET NULL
    - `cases_project_id_fkey` — FOREIGN KEY (project_id) REFERENCES projects(redpash_id) ON DELETE SET NULL
    - `cases_redpash_id_fkey` — FOREIGN KEY (redpash_id) REFERENCES entities(id) ON DELETE CASCADE
- **Checks:**
    - `cases_priority_check` — CHECK ((priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text])))
    - `cases_status_check` — CHECK ((status = ANY (ARRAY['backlog'::text, 'todo'::text, 'in_progress'::text, 'in_review'::text, 'done'::text])))
    - `cases_type_check` — CHECK ((type = ANY (ARRAY['bug'::text, 'feature'::text, 'task'::text, 'epic'::text])))
- **Indexes:**
    - `CREATE INDEX cases_category_idx ON public.cases USING btree (category_id) WHERE (category_id IS NOT NULL)`
    - `CREATE UNIQUE INDEX cases_pkey ON public.cases USING btree (redpash_id)`
    - `CREATE INDEX cases_project_idx ON public.cases USING btree (project_id, updated_at DESC) WHERE (project_id IS NOT NULL)`
    - `CREATE INDEX cases_status_idx ON public.cases USING btree (status, updated_at DESC)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:cases END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
