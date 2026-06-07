# `public.project_steps`

## Schema

<!-- doc-gen:schema:project_steps START — generated from the live DB; do not hand-edit -->
**Table `public.project_steps`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `redpash_id` | text | NO |  |
| 2 | `file_redpash_id` | text | NO |  |
| 3 | `ordinal` | integer | NO |  |
| 4 | `kind` | text | NO |  |
| 5 | `params` | jsonb | NO | `'{}'::jsonb` |
| 6 | `applied` | boolean | NO | `true` |
| 7 | `created_at` | timestamp with time zone | NO | `now()` |

- **Primary key:** `PRIMARY KEY (redpash_id)`
- **Foreign keys:**
    - `project_steps_file_redpash_id_fkey` — FOREIGN KEY (file_redpash_id) REFERENCES project_files(redpash_id) ON DELETE CASCADE
- **Indexes:**
    - `CREATE INDEX project_steps_file_idx ON public.project_steps USING btree (file_redpash_id, ordinal)`
    - `CREATE UNIQUE INDEX project_steps_pkey ON public.project_steps USING btree (redpash_id)`
- **Triggers:** 
    - `project_steps_bump_file` — CREATE TRIGGER project_steps_bump_file AFTER INSERT OR DELETE OR UPDATE ON public.project_steps FOR EACH ROW EXECUTE FUNCTION bump_file_mtime_from_step()
<!-- doc-gen:schema:project_steps END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
