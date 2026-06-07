# `public.type_fields`

## Schema

<!-- doc-gen:schema:type_fields START — generated from the live DB; do not hand-edit -->
**Table `public.type_fields`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `type_id` | text | NO |  |
| 2 | `field` | text | NO |  |
| 3 | `ordinal` | integer | NO |  |
| 4 | `data_type` | text | NO |  |
| 5 | `perm_class` | text | NO |  |
| 6 | `is_sortable` | boolean | NO | `true` |
| 7 | `options` | jsonb | NO | `'[]'::jsonb` |
| 8 | `rel_type` | text | YES |  |
| 9 | `rel_multi` | boolean | NO | `false` |
| 10 | `validate` | jsonb | NO | `'[]'::jsonb` |

- **Primary key:** `PRIMARY KEY (type_id, field)`
- **Foreign keys:**
    - `type_fields_type_id_fkey` — FOREIGN KEY (type_id) REFERENCES type_definitions(type_id) ON DELETE CASCADE
- **Indexes:**
    - `CREATE UNIQUE INDEX type_fields_pkey ON public.type_fields USING btree (type_id, field)`
    - `CREATE INDEX type_fields_type_ordinal ON public.type_fields USING btree (type_id, ordinal)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:type_fields END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
