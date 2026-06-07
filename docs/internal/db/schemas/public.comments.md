# `public.comments`

## Schema

<!-- doc-gen:schema:comments START — generated from the live DB; do not hand-edit -->
**Table `public.comments`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `redpash_id` | text | NO |  |
| 2 | `case_id` | text | NO |  |
| 3 | `author_id` | text | YES |  |
| 4 | `body` | text | NO |  |
| 5 | `is_edited` | boolean | NO | `false` |
| 6 | `created_at` | timestamp with time zone | NO | `now()` |
| 7 | `updated_at` | timestamp with time zone | NO | `now()` |
| 8 | `attachments` | jsonb | NO | `'[]'::jsonb` |

- **Primary key:** `PRIMARY KEY (redpash_id)`
- **Foreign keys:**
    - `comments_author_id_fkey` — FOREIGN KEY (author_id) REFERENCES users(redpash_id) ON DELETE SET NULL
    - `comments_case_id_fkey` — FOREIGN KEY (case_id) REFERENCES cases(redpash_id) ON DELETE CASCADE
- **Indexes:**
    - `CREATE INDEX comments_case_idx ON public.comments USING btree (case_id, created_at)`
    - `CREATE UNIQUE INDEX comments_pkey ON public.comments USING btree (redpash_id)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:comments END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
