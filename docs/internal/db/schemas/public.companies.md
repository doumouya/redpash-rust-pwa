# `public.companies`

## Schema

<!-- doc-gen:schema:companies START — generated from the live DB; do not hand-edit -->
**Table `public.companies`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `redpash_id` | text | NO |  |
| 2 | `name` | text | NO |  |
| 3 | `slug` | text | NO |  |
| 4 | `avatar_url` | text | YES |  |
| 5 | `created_at` | timestamp with time zone | NO | `now()` |
| 6 | `updated_at` | timestamp with time zone | NO | `now()` |

- **Primary key:** `PRIMARY KEY (redpash_id)`
- **Foreign keys:**
    - `companies_redpash_id_fkey` — FOREIGN KEY (redpash_id) REFERENCES entities(id) ON DELETE CASCADE
- **Unique:**
    - `companies_slug_key` — UNIQUE (slug)
- **Indexes:**
    - `CREATE UNIQUE INDEX companies_pkey ON public.companies USING btree (redpash_id)`
    - `CREATE UNIQUE INDEX companies_slug_key ON public.companies USING btree (slug)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:companies END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
