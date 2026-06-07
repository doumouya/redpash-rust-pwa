# `public.sessions`

## Schema

<!-- doc-gen:schema:sessions START — generated from the live DB; do not hand-edit -->
**Table `public.sessions`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `redpash_id` | text | NO |  |
| 2 | `user_redpash_id` | text | NO |  |
| 3 | `expires_at` | timestamp with time zone | NO |  |
| 4 | `created_at` | timestamp with time zone | NO | `now()` |

- **Primary key:** `PRIMARY KEY (redpash_id)`
- **Foreign keys:**
    - `sessions_user_redpash_id_fkey` — FOREIGN KEY (user_redpash_id) REFERENCES users(redpash_id) ON DELETE CASCADE
- **Indexes:**
    - `CREATE INDEX sessions_expiry_idx ON public.sessions USING btree (expires_at)`
    - `CREATE UNIQUE INDEX sessions_pkey ON public.sessions USING btree (redpash_id)`
    - `CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_redpash_id)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:sessions END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
