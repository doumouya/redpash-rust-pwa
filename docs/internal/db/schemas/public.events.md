# `public.events`

## Schema

<!-- doc-gen:schema:events START — generated from the live DB; do not hand-edit -->
**Table `public.events`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `redpash_id` | text | NO |  |
| 2 | `occurred_at` | timestamp with time zone | NO | `now()` |
| 3 | `origin` | text | NO | `'backend'::text` |
| 4 | `level` | text | NO | `'info'::text` |
| 5 | `kind` | text | NO |  |
| 6 | `message` | text | NO |  |
| 7 | `source` | text | YES |  |
| 8 | `user_redpash_id` | text | YES |  |
| 9 | `session_id` | text | YES |  |
| 10 | `request_id` | text | YES |  |
| 11 | `http_method` | text | YES |  |
| 12 | `http_path` | text | YES |  |
| 13 | `http_status` | integer | YES |  |
| 14 | `duration_ms` | integer | YES |  |
| 15 | `context` | jsonb | NO | `'{}'::jsonb` |

- **Primary key:** `PRIMARY KEY (redpash_id)`
- **Foreign keys:**
    - `events_user_redpash_id_fkey` — FOREIGN KEY (user_redpash_id) REFERENCES users(redpash_id) ON DELETE SET NULL
- **Checks:**
    - `events_level_check` — CHECK ((level = ANY (ARRAY['debug'::text, 'info'::text, 'warn'::text, 'error'::text])))
    - `events_origin_check` — CHECK ((origin = ANY (ARRAY['backend'::text, 'frontend'::text])))
- **Indexes:**
    - `CREATE INDEX events_kind_idx ON public.events USING btree (kind, occurred_at DESC)`
    - `CREATE INDEX events_level_idx ON public.events USING btree (level, occurred_at DESC)`
    - `CREATE INDEX events_occurred_idx ON public.events USING btree (occurred_at DESC)`
    - `CREATE UNIQUE INDEX events_pkey ON public.events USING btree (redpash_id)`
    - `CREATE INDEX events_request_idx ON public.events USING btree (request_id)`
    - `CREATE INDEX events_user_idx ON public.events USING btree (user_redpash_id, occurred_at DESC)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:events END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
