# `public.user_preferences`

## Schema

<!-- doc-gen:schema:user_preferences START — generated from the live DB; do not hand-edit -->
**Table `public.user_preferences`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `user_redpash_id` | text | NO |  |
| 2 | `key` | text | NO |  |
| 3 | `value` | jsonb | NO |  |
| 4 | `updated_at` | timestamp with time zone | NO | `now()` |

- **Primary key:** `PRIMARY KEY (user_redpash_id, key)`
- **Foreign keys:**
    - `user_preferences_user_redpash_id_fkey` — FOREIGN KEY (user_redpash_id) REFERENCES users(redpash_id) ON DELETE CASCADE
- **Indexes:**
    - `CREATE UNIQUE INDEX user_preferences_pkey ON public.user_preferences USING btree (user_redpash_id, key)`
    - `CREATE INDEX user_preferences_user_idx ON public.user_preferences USING btree (user_redpash_id)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:user_preferences END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
