# `public.field_permissions`

## Schema

<!-- doc-gen:schema:field_permissions START — generated from the live DB; do not hand-edit -->
**Table `public.field_permissions`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `object_type` | text | NO |  |
| 2 | `field` | text | NO |  |
| 3 | `role` | text | NO |  |
| 4 | `permission` | text | NO |  |
| 5 | `updated_at` | timestamp with time zone | NO | `now()` |
| 6 | `updated_by` | text | YES |  |

- **Primary key:** `PRIMARY KEY (object_type, field, role)`
- **Checks:**
    - `field_permissions_permission_check` — CHECK ((permission = ANY (ARRAY['write'::text, 'read'::text, 'none'::text])))
    - `field_permissions_role_check` — CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text, 'viewer'::text])))
- **Indexes:**
    - `CREATE UNIQUE INDEX field_permissions_pkey ON public.field_permissions USING btree (object_type, field, role)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:field_permissions END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
