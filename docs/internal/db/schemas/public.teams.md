# `public.teams`

## Schema

<!-- doc-gen:schema:teams START — generated from the live DB; do not hand-edit -->
**Table `public.teams`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `redpash_id` | text | NO |  |
| 2 | `company_id` | text | NO |  |
| 3 | `name` | text | NO |  |
| 4 | `created_at` | timestamp with time zone | NO | `now()` |
| 5 | `kind` | text | NO | `'team'::text` |

- **Primary key:** `PRIMARY KEY (redpash_id)`
- **Foreign keys:**
    - `teams_company_id_fkey` — FOREIGN KEY (company_id) REFERENCES companies(redpash_id) ON DELETE CASCADE
    - `teams_redpash_id_fkey` — FOREIGN KEY (redpash_id) REFERENCES entities(id) ON DELETE CASCADE
- **Checks:**
    - `teams_kind_check` — CHECK ((kind = ANY (ARRAY['team'::text, 'department'::text])))
- **Indexes:**
    - `CREATE INDEX teams_company_idx ON public.teams USING btree (company_id)`
    - `CREATE UNIQUE INDEX teams_pkey ON public.teams USING btree (redpash_id)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:teams END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
