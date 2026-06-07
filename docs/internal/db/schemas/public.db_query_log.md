# `public.db_query_log`

## Schema

<!-- doc-gen:schema:db_query_log START — generated from the live DB; do not hand-edit -->
**Table `public.db_query_log`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `id` | bigint | NO | `nextval('db_query_log_id_seq'::regclass)` |
| 2 | `at` | timestamp with time zone | NO | `now()` |
| 3 | `query_template` | text | NO |  |
| 4 | `duration_ms` | integer | NO |  |
| 5 | `rows` | bigint | YES |  |
| 6 | `status` | smallint | NO | `0` |
| 7 | `error_kind` | text | YES |  |
| 8 | `request_id` | text | YES |  |
| 9 | `user_redpash_id` | text | YES |  |
| 10 | `route` | text | YES |  |

- **Primary key:** `PRIMARY KEY (id)`
- **Indexes:**
    - `CREATE INDEX db_query_log_at_idx ON public.db_query_log USING btree (at DESC)`
    - `CREATE UNIQUE INDEX db_query_log_pkey ON public.db_query_log USING btree (id)`
    - `CREATE INDEX db_query_log_request_idx ON public.db_query_log USING btree (request_id) WHERE (request_id IS NOT NULL)`
    - `CREATE INDEX db_query_log_template_idx ON public.db_query_log USING btree (query_template, at DESC)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:db_query_log END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
