# `public.request_log`

## Schema

<!-- doc-gen:schema:request_log START — generated from the live DB; do not hand-edit -->
**Table `public.request_log`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `id` | bigint | NO | `nextval('request_log_id_seq'::regclass)` |
| 2 | `at` | timestamp with time zone | NO | `now()` |
| 3 | `method` | text | NO |  |
| 4 | `route` | text | NO |  |
| 5 | `status` | smallint | NO |  |
| 6 | `duration_ms` | integer | NO |  |
| 7 | `request_id` | text | YES |  |
| 8 | `user_redpash_id` | text | YES |  |
| 9 | `session_id` | text | YES |  |

- **Primary key:** `PRIMARY KEY (id)`
- **Indexes:**
    - `CREATE INDEX request_log_at_idx ON public.request_log USING btree (at DESC)`
    - `CREATE UNIQUE INDEX request_log_pkey ON public.request_log USING btree (id)`
    - `CREATE INDEX request_log_route_idx ON public.request_log USING btree (route, at DESC)`
    - `CREATE INDEX request_log_session_idx ON public.request_log USING btree (session_id, at DESC) WHERE (session_id IS NOT NULL)`
    - `CREATE INDEX request_log_user_idx ON public.request_log USING btree (user_redpash_id, at DESC) WHERE (user_redpash_id IS NOT NULL)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:request_log END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
