# `public.users`

## Schema

<!-- doc-gen:schema:users START — generated from the live DB; do not hand-edit -->
**Table `public.users`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `redpash_id` | text | NO |  |
| 2 | `username` | text | NO |  |
| 3 | `email` | text | YES |  |
| 4 | `display_name` | text | NO |  |
| 5 | `avatar_url` | text | YES |  |
| 6 | `job_title` | text | YES |  |
| 7 | `organisation` | text | YES |  |
| 8 | `use_case` | text | YES |  |
| 9 | `plan` | text | NO | `'free'::text` |
| 10 | `locale` | text | NO | `'en'::text` |
| 11 | `google_sub` | text | YES |  |
| 12 | `first_name` | text | YES |  |
| 13 | `last_name` | text | YES |  |
| 14 | `default_project_id` | text | YES |  |
| 15 | `status` | text | NO | `'active'::text` |
| 16 | `created_at` | timestamp with time zone | NO | `now()` |
| 17 | `updated_at` | timestamp with time zone | NO | `now()` |
| 18 | `role` | text | NO | `'user'::text` |

- **Primary key:** `PRIMARY KEY (redpash_id)`
- **Foreign keys:**
    - `users_default_project_id_fkey` — FOREIGN KEY (default_project_id) REFERENCES projects(redpash_id) ON DELETE SET NULL
    - `users_entity_fk` — FOREIGN KEY (redpash_id) REFERENCES entities(id) ON DELETE CASCADE
- **Checks:**
    - `users_role_check` — CHECK ((role = ANY (ARRAY['admin'::text, 'user'::text])))
    - `users_status_check` — CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'archived'::text])))
- **Unique:**
    - `users_username_key` — UNIQUE (username)
- **Indexes:**
    - `CREATE UNIQUE INDEX users_google_sub_idx ON public.users USING btree (google_sub) WHERE (google_sub IS NOT NULL)`
    - `CREATE UNIQUE INDEX users_pkey ON public.users USING btree (redpash_id)`
    - `CREATE UNIQUE INDEX users_username_key ON public.users USING btree (username)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:users END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
