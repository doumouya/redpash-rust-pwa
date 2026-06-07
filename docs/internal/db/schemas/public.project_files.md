# `public.project_files`

## Schema

<!-- doc-gen:schema:project_files START — generated from the live DB; do not hand-edit -->
**Table `public.project_files`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `redpash_id` | text | NO |  |
| 2 | `project_redpash_id` | text | NO |  |
| 3 | `filename` | text | NO |  |
| 4 | `display_name` | text | YES |  |
| 5 | `file_type` | text | NO | `'csv'::text` |
| 6 | `row_count` | bigint | YES |  |
| 7 | `col_count` | integer | YES |  |
| 8 | `file_size_bytes` | bigint | YES |  |
| 9 | `cleanness_pct` | real | YES |  |
| 10 | `encoding` | text | YES |  |
| 11 | `delimiter` | text | YES | `','::text` |
| 12 | `storage_path` | text | NO |  |
| 13 | `columns_meta` | jsonb | NO | `'[]'::jsonb` |
| 14 | `spec` | jsonb | NO | `'{}'::jsonb` |
| 15 | `source_file_id` | text | YES |  |
| 16 | `is_public` | boolean | NO | `false` |
| 17 | `is_favorite` | boolean | NO | `false` |
| 18 | `folder` | text | YES |  |
| 19 | `description` | text | YES |  |
| 20 | `created_at` | timestamp with time zone | NO | `now()` |
| 21 | `updated_at` | timestamp with time zone | NO | `now()` |

- **Primary key:** `PRIMARY KEY (redpash_id)`
- **Foreign keys:**
    - `project_files_project_redpash_id_fkey` — FOREIGN KEY (project_redpash_id) REFERENCES projects(redpash_id) ON DELETE CASCADE
    - `project_files_source_file_id_fkey` — FOREIGN KEY (source_file_id) REFERENCES project_files(redpash_id) ON DELETE CASCADE
- **Indexes:**
    - `CREATE UNIQUE INDEX project_files_pkey ON public.project_files USING btree (redpash_id)`
    - `CREATE INDEX project_files_proj_idx ON public.project_files USING btree (project_redpash_id)`
    - `CREATE INDEX project_files_source_idx ON public.project_files USING btree (source_file_id)`
    - `CREATE INDEX project_files_type_idx ON public.project_files USING btree (file_type)`
- **Triggers:** 
    - `project_files_bump_project` — CREATE TRIGGER project_files_bump_project AFTER INSERT OR DELETE OR UPDATE ON public.project_files FOR EACH ROW EXECUTE FUNCTION bump_project_mtime_from_file()
<!-- doc-gen:schema:project_files END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
