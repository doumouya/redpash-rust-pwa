# `public.type_definitions`

## Schema

<!-- doc-gen:schema:type_definitions START — generated from the live DB; do not hand-edit -->
**Table `public.type_definitions`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `type_id` | text | NO |  |
| 2 | `rid_prefix` | text | NO |  |
| 3 | `display_name` | text | NO |  |
| 4 | `display_name_plural` | text | NO |  |
| 5 | `rail_icon` | text | YES |  |
| 6 | `default_columns` | jsonb | NO | `'[]'::jsonb` |
| 7 | `default_sort` | text | YES |  |
| 8 | `is_builtin` | boolean | NO | `true` |
| 9 | `created_at` | timestamp with time zone | NO | `now()` |

- **Primary key:** `PRIMARY KEY (type_id)`
- **Indexes:**
    - `CREATE UNIQUE INDEX type_definitions_pkey ON public.type_definitions USING btree (type_id)`
    - `CREATE UNIQUE INDEX type_definitions_rid_prefix_udef ON public.type_definitions USING btree (rid_prefix) WHERE (NOT is_builtin)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:type_definitions END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
