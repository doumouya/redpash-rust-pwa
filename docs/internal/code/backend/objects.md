# Objects — one generic resource over every registered type

`/api/objects/:type[/:rid]` is **one** handler set that serves every row in
`type_definitions`. The registry premise (day-one #1): declaring a type — a row,
not a migration — auto-wires storage, CRUD, RBAC, audit, and typed fields. A new
**custom** type gets the full surface with **zero new code**; it lands on the
polymorphic `entity_data` JSONB store and rides this module as-is. This is the
"framework, not product" thesis made literal: the closed enum of object types
that a monolith hard-codes is, here, data.

**Source:** [`backend/crates/api/src/objects.rs`](../../../../backend/crates/api/src/objects.rs)
(the resource), [`types.rs`](../../../../backend/crates/api/src/types.rs)
(`/api/types`, the catalog the FE builds grids off), and
[`type_cache.rs`](../../../../backend/crates/api/src/type_cache.rs) (the
type→table map + the generated cascade).

The routes ([objects.rs:34](../../../../backend/crates/api/src/objects.rs#L34)):

```
GET    /:type           list      POST  /:type           create
GET    /:type/:rid      get_one    PATCH /:type/:rid      patch
                                   DELETE /:type/:rid      delete_one
```

Every handler opens with `require_type` ([objects.rs:64](../../../../backend/crates/api/src/objects.rs#L64))
— an unregistered `:type` is a leak-free 404 keyed off `type_cache.is_type`.

---

## Two stores, one wire shape

There are two physical homes for object rows, and the module dispatches between
them on the **same** `ObjectView` wire shape
([objects.rs:40](../../../../backend/crates/api/src/objects.rs#L40)):

- **Custom types → `entity_data`** (the polymorphic JSONB store). One handler
  body, one table, every custom type. `data` is an opaque JSON object stored
  as-is; there is **no field catalog** for custom types yet, so no field gate
  applies to them.
- **Org builtins (`user` / `company` / `team`) → their TYPED tables** (`users` /
  `companies` / `teams`). `org_builtin(type_id)`
  ([objects.rs:437](../../../../backend/crates/api/src/objects.rs#L437)) returns
  `Some((table, reach))` and every handler forks to a `builtin_*` variant that
  reads/writes real typed columns — but emits the identical `{type, rid, owner,
  scope_parent?, data}` envelope. The client can't tell which store backed a row.

The dispatch is a single `if let Some((table, _)) = org_builtin(&type_id)` at the
top of each handler ([objects.rs:89](../../../../backend/crates/api/src/objects.rs#L89),
[:156](../../../../backend/crates/api/src/objects.rs#L156),
[:183](../../../../backend/crates/api/src/objects.rs#L183),
[:319](../../../../backend/crates/api/src/objects.rs#L319)); everything below it
is the entity_data path.

`type_cache::builtin_table`
([type_cache.rs:42](../../../../backend/crates/api/src/type_cache.rs#L42)) is the
ONE place that knows where each builtin's rows live (extend it in the same commit
as the migration). `org_builtin` is a deliberately narrower list — only the three
**editable** builtins plus the read-only browse types below.

---

## The generic CRUD path (entity_data)

**create** ([objects.rs:76](../../../../backend/crates/api/src/objects.rs#L76)).
Mints a rid from the type's `rid_prefix`, then in **one tx**: `register_entity`
(the registry row, [db.rs:45](../../../../backend/crates/api/src/db.rs#L45)) →
`INSERT entity_data` → `grant_owner` (the creator's owner edge). The registry row
is written first; the FK cascade hangs off it. An audit `*_create` event fires
after commit.

**patch** ([objects.rs:170](../../../../backend/crates/api/src/objects.rs#L170)).
Loads the row (404 leak-free), runs the coarse `Action::Edit` gate, then
**merges** the body's keys into the stored `data` object (shallow insert) and
`UPDATE`s. Custom types are catalog-free, so the merge is stored verbatim.

**get_one** ([objects.rs:150](../../../../backend/crates/api/src/objects.rs#L150))
— any reach (`Action::View`). **delete_one**
([objects.rs:221](../../../../backend/crates/api/src/objects.rs#L221)) — `Action::Delete`
(Admin+ on the object), deleting through `db::delete_entity` so the FK cascade
clears the `entity_data` row + memberships. (`user` is special: SCRUB-RETAINED,
not hard-deleted — see below.)

### The scope_parent_id IDOR guard (day-one #3)

A `create` body may carry `scope_parent_id` — the parent the new object hangs
under (its cascade root). Left ungated, any authed user could graft an object
under a **foreign** scope and hand that scope's admins cascade write over it. So
before the insert ([objects.rs:97](../../../../backend/crates/api/src/objects.rs#L97)):

```rust
rbac::require_rule(&state.db, &state.type_cache, &caller, parent, kind,
    |g| g.effective().is_some_and(|r| r >= Role::Member)).await?;
```

The caller must reach the supplied parent at **>= Member**. `require_rule` 404s
an unreachable/foreign parent (leak-free — you can't probe for a scope you can't
see). The `entity_data.scope_parent_id` FK is the second line: it refuses a
dangling parent at the DB. The builtin path applies the **same** rule to its
typed parent column (`team.company_id` —
[objects.rs:833](../../../../backend/crates/api/src/objects.rs#L833)), with an
explicit existence check folded into the same leak-free 404.

---

## The org-builtin path (typed tables)

`builtin_create` / `builtin_patch` / `builtin_view` / `builtin_list`
([objects.rs:785](../../../../backend/crates/api/src/objects.rs#L785) onward)
mirror the generic path against real columns:

- **Catalog validation.** Writes are checked against `type_fields` (the field
  catalog, ordinal order — `catalog_fields`,
  [objects.rs:583](../../../../backend/crates/api/src/objects.rs#L583)).
  `validate_payload` ([objects.rs:608](../../../../backend/crates/api/src/objects.rs#L608))
  rejects an unknown key (`400 unknown_field` — the wire contract), enforces
  string/null values (every catalog column is text), respects declared `options`,
  and won't null-out a required field. `required_on_create`
  ([objects.rs:566](../../../../backend/crates/api/src/objects.rs#L566)) is the
  one place the NOT-NULL birth inputs live.
- **The same insert tx.** `builtin_create` does a dynamic INSERT over only the
  provided catalog columns (DB defaults fill the rest), wrapped in the same
  `register_entity` → insert → `grant_owner` tx as the generic path.
- **No `owner_id` column.** Typed tables have no owner column — ownership IS a
  membership row, so `builtin_view`
  ([objects.rs:765](../../../../backend/crates/api/src/objects.rs#L765)) reads the
  first `owner` membership edge.

### The field gate (after the coarse Edit gate)

`builtin_patch` ([objects.rs:903](../../../../backend/crates/api/src/objects.rs#L903))
runs gates in a deliberate order: 404-leak-free load → coarse `Action::Edit`
gate → catalog validation → **the field gate**
(`field_perms::require_fields`, [objects.rs:917](../../../../backend/crates/api/src/objects.rs#L917))
→ typed UPDATE of exactly the provided columns. The field gate runs **after** the
coarse gate so its denial can be a `403 field_forbidden` naming the first blocked
field — existence is already admitted, nothing leaks. `builtin_create` runs the
equivalent at the **owner tier** (the creator becomes owner), exempting
required-on-create fields (birth inputs, not edits —
[objects.rs:818](../../../../backend/crates/api/src/objects.rs#L818)). Platform
admins bypass every gate. The cell matrix and `PermClass` derivation are owned by
[`field_perms.rs`](../../../../backend/crates/api/src/field_perms.rs); see
[`rbac.md`](rbac.md) for the depth.

---

## Read-only registry types (file / project / case)

`file` / `project` / `case` are **browse + DELETE only** —
`registry_read_only(type_id)` ([objects.rs:497](../../../../backend/crates/api/src/objects.rs#L497))
makes create/patch return `not_creatable` / `not_editable`. These objects are
created and advanced by their own flows (upload, `/projects`, the `/api/cases`
workflow engine) which own non-text, provenance-owned columns; the registry only
lists/views/deletes them. (`file` is scoped to `file_type = 'csv'` —
`builtin_row_scope`, [objects.rs:507](../../../../backend/crates/api/src/objects.rs#L507)
— since charts/dashboards share `project_files` but belong to the Designer.)

### registry_display_fields — derive-all-columns + the HIDDEN_COLUMNS denylist

For a read-only type there's no curated editable catalog, so
`registry_display_fields` ([objects.rs:683](../../../../backend/crates/api/src/objects.rs#L683))
**derives every real column** of the typed table from
`information_schema.columns` (don't hand-seed) — the browse view shows the WHOLE
object. `type_fields` is then an **overlay for ORDER** only: cataloged fields
first in their ordinal, then the remaining real columns in schema order. The
`bool` per field flags cataloged-vs-derived.

`HIDDEN_COLUMNS` ([objects.rs:662](../../../../backend/crates/api/src/objects.rs#L662))
is the denylist subtracted from the derived set — internal/sensitive columns the
registry NEVER surfaces even though they're real:

| column | why hidden |
|---|---|
| `google_sub` | the OAuth subject — a server secret |
| `storage_path` | the on-disk file path — server filesystem |
| `columns_meta` | per-column CSV profile incl. `sample` = the first real cell VALUE of each column (raw user data; the bulk list would broadcast it, unmaskably) |
| `spec` | chart/dashboard config JSON (data-derived) |

This is **DISPLAY-only**. The write gate is the curated `type_fields`
(`validate_payload`), so deriving here never widens what PATCH/create accept — a
hidden or derived column is unreachable for writes regardless.

This same function backs `/api/types`
([types.rs:105](../../../../backend/crates/api/src/types.rs#L105)): the FE column
headers (types) and the row data (objects) share **one** field set, so the
client's column ∩ row-keys intersection keeps every field. `/api/types` appends
the derived columns as `readonly` display fields with the same HIDDEN_COLUMNS
applied ([types.rs:98](../../../../backend/crates/api/src/types.rs#L98)).

---

## The list shape + the reach clause

Both list paths return one envelope:

```json
{ "items": [ {…flat row incl. "rid"} ], "total", "all_count", "page", "size" }
```

- `total` — rows matching the reach **and** the optional `q` substring.
- `all_count` — rows matching the reach alone, **reach-scoped, never the platform
  total** (a KPI must not leak the global count).
- `q` ([objects.rs:298](../../../../backend/crates/api/src/objects.rs#L298)) is a
  coarse server-side substring fallback (`ILIKE` over `data::text` for entity_data,
  `concat_ws` over the display columns for builtins); the **client engine does
  the real shaping** — this is the server-side backstop, not the query surface.
- `size` clamps to `[1, 500]`; default page 1, size 50.

**Reach** = direct membership on the object OR its `scope_parent` (the cascade).
The entity_data list compiles it as the `REACH` constant
([objects.rs:330](../../../../backend/crates/api/src/objects.rs#L330)): a
membership edge on `ed.object_id` OR `ed.scope_parent_id`. The principal closure
is bound as `$2` — `None` (NULL) means a platform admin, which **disables the
filter** (every row); otherwise it's `rbac::principals(caller)`
([objects.rs:323](../../../../backend/crates/api/src/objects.rs#L323)).

Each org builtin carries its **own** reach predicate, rewritten over typed
columns but mirroring the same membership-or-cascade rule
([objects.rs:437](../../../../backend/crates/api/src/objects.rs#L437)): `user`
adds self-visibility (`t.redpash_id = ANY($1)`), `team` reaches via the row or
its `company_id`, `file` via the file/project/company chain. `CASE_REACH`
([objects.rs:432](../../../../backend/crates/api/src/objects.rs#L432)) is a
`pub(crate)` const **shared** with the dedicated `/api/cases` list so the browse
view and the workflow surface can't drift. Builtin lists also run **per-row READ
masking** ([objects.rs:1016](../../../../backend/crates/api/src/objects.rs#L1016))
— the matrix loads once; the per-row tier resolve only fires when a hiding
override is actually stored (`FieldMatrix::fully_readable` is the fast path).

---

## Why this shape — the cascade comes from the DB

The reach predicates above all rest on the **generated cascade** (day-one #6):
`type_definitions.scope_parents` rows are compiled into one `parent-edge` SQL
fragment in `type_cache::load`
([type_cache.rs:107](../../../../backend/crates/api/src/type_cache.rs#L107)),
shared by every RBAC consumer via `rbac_with_clause`
([type_cache.rs:141](../../../../backend/crates/api/src/type_cache.rs#L141)). The
custom-type arm (`entity_data.scope_parent_id`) is one of those edges
([type_cache.rs:92](../../../../backend/crates/api/src/type_cache.rs#L92)) — which
is exactly why a custom type's IDOR guard and reach work with zero bespoke code.
There is one copy of the cascade knowledge in the process, and it came from the
DB.

## See also

- [`rbac.md`](rbac.md) — the gate vocabulary (`require_action` / `require_rule` /
  `resolve_grant`, `principals`, the recursive scope CTE) and the field-perms
  matrix depth (`PermClass` → cells → overrides) this doc links to but does not
  own.
- [`api-routes.md`](api-routes.md) — where `/api/objects` + `/api/types` sit in
  the full route catalog, and the leak-free-404 denial model.
- [day-one decisions](../../../decisions/day-one.md) — #1 (prefixes / type-as-data),
  #3 (the IDOR guard), #6 (the generated cascade).
