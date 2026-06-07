# `public.type_scope_roles`

## Schema

<!-- doc-gen:schema:type_scope_roles START — generated from the live DB; do not hand-edit -->
**Table `public.type_scope_roles`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `scope` | text | NO |  |
| 2 | `role` | text | NO |  |
| 3 | `is_context` | boolean | NO | `false` |
| 4 | `is_default` | boolean | NO | `false` |
| 5 | `ordinal` | integer | NO | `0` |

- **Primary key:** `PRIMARY KEY (scope, role, is_context)`
- **Indexes:**
    - `CREATE UNIQUE INDEX type_scope_roles_pkey ON public.type_scope_roles USING btree (scope, role, is_context)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:type_scope_roles END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
