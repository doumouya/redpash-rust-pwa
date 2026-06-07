# `public.entities`

## Schema

<!-- doc-gen:schema:entities START — generated from the live DB; do not hand-edit -->
**Table `public.entities`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `id` | text | NO |  |
| 2 | `type` | text | NO |  |
| 3 | `created_at` | timestamp with time zone | NO | `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Foreign keys:**
    - `entities_type_fk` — FOREIGN KEY (type) REFERENCES type_definitions(type_id)
- **Indexes:**
    - `CREATE UNIQUE INDEX entities_pkey ON public.entities USING btree (id)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:entities END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
