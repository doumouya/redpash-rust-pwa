# `public.memberships`

## Schema

<!-- doc-gen:schema:memberships START — generated from the live DB; do not hand-edit -->
**Table `public.memberships`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `object_redpash_id` | text | NO |  |
| 2 | `member_redpash_id` | text | NO |  |
| 3 | `role` | text | NO | `'member'::text` |
| 4 | `context_role` | text | NO | `''::text` |
| 5 | `joined_at` | timestamp with time zone | NO | `now()` |

- **Primary key:** `PRIMARY KEY (object_redpash_id, member_redpash_id, role, context_role)`
- **Foreign keys:**
    - `memberships_member_fk` — FOREIGN KEY (member_redpash_id) REFERENCES entities(id) ON DELETE CASCADE
    - `memberships_object_redpash_id_fkey` — FOREIGN KEY (object_redpash_id) REFERENCES entities(id) ON DELETE CASCADE
- **Checks:**
    - `memberships_role_check` — CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text, 'viewer'::text])))
- **Indexes:**
    - `CREATE INDEX memberships_member_idx ON public.memberships USING btree (member_redpash_id, object_redpash_id)`
    - `CREATE UNIQUE INDEX memberships_pkey ON public.memberships USING btree (object_redpash_id, member_redpash_id, role, context_role)`
- **Triggers:** 
    - `trigger_one_department_per_user` — CREATE TRIGGER trigger_one_department_per_user BEFORE INSERT OR UPDATE ON public.memberships FOR EACH ROW EXECUTE FUNCTION enforce_one_department_per_user()
<!-- doc-gen:schema:memberships END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
