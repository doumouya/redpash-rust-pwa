# `public.sentinel_submissions`

## Schema

<!-- doc-gen:schema:sentinel_submissions START — generated from the live DB; do not hand-edit -->
**Table `public.sentinel_submissions`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `canonical` | text | NO |  |
| 2 | `user_id` | text | NO |  |
| 3 | `submitted_at` | timestamp with time zone | NO | `now()` |

- **Primary key:** `PRIMARY KEY (canonical, user_id)`
- **Foreign keys:**
    - `sentinel_submissions_user_id_fkey` — FOREIGN KEY (user_id) REFERENCES users(redpash_id) ON DELETE CASCADE
- **Indexes:**
    - `CREATE UNIQUE INDEX sentinel_submissions_pkey ON public.sentinel_submissions USING btree (canonical, user_id)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:sentinel_submissions END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
