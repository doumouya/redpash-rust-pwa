# `public.connectors`

## Schema

<!-- doc-gen:schema:connectors START — generated from the live DB; do not hand-edit -->
**Table `public.connectors`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `redpash_id` | text | NO |  |
| 2 | `project_id` | text | NO |  |
| 3 | `name` | text | NO |  |
| 4 | `kind` | text | NO | `'kafka'::text` |
| 5 | `topic` | text | YES |  |
| 6 | `as_user` | text | NO |  |
| 7 | `created_by` | text | NO |  |
| 8 | `config` | jsonb | NO | `'{}'::jsonb` |
| 9 | `created_at` | timestamp with time zone | NO | `now()` |

- **Primary key:** `PRIMARY KEY (redpash_id)`
- **Foreign keys:**
    - `connectors_as_user_fkey` — FOREIGN KEY (as_user) REFERENCES users(redpash_id)
    - `connectors_created_by_fkey` — FOREIGN KEY (created_by) REFERENCES users(redpash_id)
    - `connectors_project_id_fkey` — FOREIGN KEY (project_id) REFERENCES projects(redpash_id) ON DELETE CASCADE
    - `connectors_redpash_id_fkey` — FOREIGN KEY (redpash_id) REFERENCES entities(id) ON DELETE CASCADE
- **Indexes:**
    - `CREATE UNIQUE INDEX connectors_pkey ON public.connectors USING btree (redpash_id)`
    - `CREATE INDEX connectors_project_idx ON public.connectors USING btree (project_id)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:connectors END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
