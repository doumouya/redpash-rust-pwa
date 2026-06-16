# Worked example — the RedPash object registry, as BUILT (lean)

This is the method applied to the LIVE lean backend, where the registry is shipped — not a plan toward
one. It shows the as-built wiring, the exact extension recipes, and the shared-symbol seam map. Re-verify
line numbers before editing (the code moves); the symbol names are unique, so grep or rust-analyzer
rooted at `backend/` both work. The flat crate layout means there is **no `routes/` dir** — every module
is `backend/crates/api/src/<mod>.rs`.

> Live source of truth: `docs/decisions/day-one.md` (the locked decisions), `docs/REDMAP.md` (doc⇄code
> map), `docs/internal/code/backend/api-routes.md` (the HTTP catalog), `docs/decisions/registry-redundancy.md`
> (why the registry — ids + shape — lives in Postgres while cell data stays client-side).

## The registry as it ships (the parts you extend)

### The tables — `backend/migrations/20260612000000_init.sql`

- **`type_definitions`** — every type is a row: `type_id` (PK), `rid_prefix` (NOT NULL **UNIQUE** —
  day-one #1, `dashboard = DSH_`, never sharing `FIL_`), `display_name`/`display_name_plural`,
  `rail_icon`, `is_builtin`, `grid_served`, `ordinal`, and `scope_parents` jsonb (the cascade arms,
  day-one #6 — each entry names a column whose value is a parent entity the grant resolver climbs).
- **`type_fields`** — the field catalog, `PRIMARY KEY (type_id, field)`: `ordinal` (wire order),
  `data_type` (an OPEN codec id, default `'string'` — *not* an enum), `perm_class` (CHECK over
  `standard/collaborative/owner_grade/personal/readonly` — the curated permission classes the per-role
  cells DERIVE from), `is_sortable`, `options` jsonb, `rel_type`/`rel_multi`, `validate` jsonb.
- **`entity_data`** — the polymorphic JSONB store for CUSTOM types: `object_id` PK → `entities`
  `ON DELETE CASCADE`, `type_id` → `type_definitions` `ON DELETE RESTRICT`, `owner_id` → users
  `ON DELETE SET NULL`, `scope_parent_id` → `entities` **a REAL FK** `ON DELETE SET NULL` (day-one #3 —
  the create-time IDOR guard is policy; the FK makes a dangling/foreign parent unrepresentable even for
  direct-DB writes), `data` jsonb. Indexed on `type_id` and on `scope_parent_id` (partial).
- **`field_permissions`** — SPARSE per-cell OVERRIDES only (`(type_id, field, role)` PK, `can_read`/
  `can_write`); defaults derive from `perm_class`, so nothing to store unless an admin overrides a cell.
- **The 9 seeded builtins** (bottom of the migration): `user (USR)`, `company (CMP)`, `team (TEM,
  scope_parents ["company_id"])`, `project (PRJ, ["company_id"])`, `file (FIL, ["project_id"])`,
  `chart (CHT, ["project_id"])`, `dashboard (DSH, ["project_id"])`, `case (CAS, ["company_id",
  "project_id"])`, `connection (CON)`. chart/dashboard live in `project_files` (file_type slices) — they
  are registry types so RIDs resolve and TypeDefinitions serve metadata, not separate tables.

### `TypeDefCache` — `type_cache.rs`

Loaded once after migrate. `is_type` / `rid_prefix` / `object_kind(rid)` (prefix→type via a `HashMap`),
`get(type_id) -> Option<&TypeDef>`, and `builtin_table(type_id) -> Option<(&'static str, &'static str)>`
(table + pk — the ONE place builtin storage lives; file/chart/dashboard all map to `project_files`).
**The generated cascade (day-one #6):** `load()` walks `type_definitions.scope_parents`, dedups arms
(so the file family contributes the `project_id` arm once — there's a unit test for it), appends the
universal `entity_data` arm `(entity_data, object_id, scope_parent_id)`, asserts each identifier is a
bare lowercase ident (belt-and-braces over our own seed rows), and builds one `parent_edges_sql` UNION.
`rbac_with_clause()` wraps it in the recursive `principals`/`scopes` CTE every RBAC query reuses. **There
is exactly one copy of the cascade in the process, and it came from the DB.**

### The generic handler — `objects.rs` (`/api/objects/:type[/:rid]`)

ONE `list/get/create/patch/delete` for every type. `require_type` gates on `type_cache.is_type` (leak-free
404). Two storage paths behind one wire shape:

- **Custom types → `entity_data`** (JSONB). `create` registers the entity, inserts the row, auto-grants
  the creator an owner edge in ONE tx; `patch` merges field changes; `list` is reach-scoped via the
  `REACH` clause (`memberships` on the object OR its `scope_parent_id`); `all_count` is reach-scoped (a
  KPI must never leak the platform total). The IDOR guard: a supplied `scope_parent_id` must be reachable
  at ≥ Member (`rbac::require_rule`, 404 leak-free) before grafting.
- **Org builtins → typed tables** (`org_builtin(type_id) -> Option<(table, reach_clause)>` for
  user/company/team/file/project/case). `builtin_list`/`builtin_view`/`builtin_create`/`builtin_patch`
  serve the real table on the same `{items,total,all_count,page,size}` shape. Writes validate against the
  catalog (`catalog_fields` + `validate_payload` → `400 unknown_field`/`invalid_value`), then the FIELD
  GATE `field_perms::require_fields` after the coarse Edit gate.

Mechanisms to extend, not reinvent:

- **`registry_display_fields(pool, type_id) -> Option<Vec<(String, bool)>>`** — the DERIVE. Returns
  `None` for non-builtins (entity_data). For **editable** builtins (user/company/team) returns the
  curated `type_fields` (their catalog IS their editable set). For **read-only** registry builtins
  (file/project/case) returns the cataloged fields FIRST then **every remaining real table column**
  (from `information_schema.columns`) minus `HIDDEN_COLUMNS` (`google_sub`, `storage_path`,
  `columns_meta`, `spec` — server secrets/paths/opaque blobs) — so the browse view shows the WHOLE
  object with no per-column migration. The `bool` flags cataloged-vs-derived. **`types.rs` calls the same
  function**, so `/types` (headers) and `/objects` (rows) share one field set — the FE column ⋂ row-keys
  intersection keeps every field.
- **`CASE_REACH`** (`pub(crate) const`) — the case reach predicate, shared by the registry browse list
  (the `case` arm of `org_builtin`) and the dedicated `/api/cases` list in `cases.rs`, so the two can't
  drift.
- **`registry_read_only(type_id)`** — `file | project | case` are browse + DELETE only via the registry;
  they're created/edited by their own flows (upload, `/projects`, `/api/cases`).
- **The masking pair** (`mask_fields`/`mask_view`/`caller_tier`) — READ visibility is part of the
  boundary: a field the caller's tier can't read is OMITTED (presence MEANS readable). Self user rows
  resolve at owner tier (a user never loses sight of their own personal fields).

### The metadata surface — `types.rs` (`GET /api/types`)

The TypeDefinition contract the FE builds grids/editors from. `payload(pool)` reads `type_definitions` +
`type_fields` + `field_permissions` LIVE (a custom type is "a row, not a migration"; an admin override
must show on the next GET — chosen over caching `TypeDefCache`, which keeps its single job: the generated
RBAC SQL). Per-role `cells` DERIVE from `PermClass::parse(perm_class).cells()` then overlay the sparse
`field_permissions`. Then it calls `objects::registry_display_fields` and appends each uncataloged real
column as a `readonly` display field (`title_case`d label, ordinal past the curated ones).

### The newest worked example — `cases.rs` (`/api/cases` + the WORKFLOW ENGINE)

The dedicated surface the generic handler can't carry. Mirror THIS when a type needs beyond-CRUD behavior:

- **`mod workflow`** — workflows-as-DATA keyed by `cases.source`. `INTERNAL` is a transition map
  (`[(state, &[allowed_next])]`) — forward + one-step-back + reopen-from-done (kanban-friendly; a
  one-line table change toggles strict forward-only). `EXTERNAL` is DESIGNED but DORMANT (the
  `cases.status` CHECK doesn't permit its states; lighting it up needs a CHECK-widening migration). The
  engine is pure (no DB): `initial(source)`, `states(source)`, `transitions(source)`, `is_valid(source,
  from, to)`, `is_known_state(source, status)`.
- **The PATCH ENFORCES** — `patch` runs `require_action(Edit)`, fetches `(status, source)`, then
  `422 invalid_status` if `to` isn't a known state and `422 invalid_transition` if `to ∉ transitions
  [from]`. The DB enum CHECK on `cases.status` is the backstop. The MCP client surfaces the body message
  to the agent, so a rejected `setCaseStatus` skip propagates for free.
- **It REUSES the framework**: `rbac::require_action`/`require_rule` (the IDOR guard on supplied
  company/project scope_parents, ≥ Member), `db::register_entity` + `db::grant_owner` (create tx),
  `event::*` (every mutation emits a queryable activity event keyed by `context->>'case'`, indexed by
  `events_case_idx`), and `pipeline::upload_attachment` for the attachment bytes.
- **Attachments** — bytes immutable on disk via the sealed pipeline, METADATA-only in `case_attachments`
  (no bytes column; `storage_path` never crosses the wire). Download forces `attachment` disposition +
  `nosniff` (stored-XSS guard) and sanitizes the filename header.

### The sealed write path — `pipeline.rs`

`upload_csv` (parse + summarize + score off the runtime, RBAC ≥ Member on the project unless admin,
orphan-blob `BlobGuard`) and `upload_attachment` (RAW store, no parse) are the public producers.
`insert_file` and `insert_attachment` are **module-PRIVATE** — there is no public `db::insert_*`, so a
loader cannot create a file/attachment row directly and skip RBAC + audit. The connector-bypass class is
closed by visibility, not convention (day-one). `insert_file` also writes the genesis `original` step in
the same tx (the baseline cleanness the score trajectory starts from).

## Extension recipes (the common asks, the right move)

- **Add a CUSTOM object type** (e.g. a real-estate `Listing`, or an outbound `integration`/webhook
  registry): INSERT a `type_definitions` row (unique `rid_prefix`; `scope_parents: ["scope_parent_id"]`
  if it cascades under a parent) + its `type_fields`. Done — `/api/objects/:type` gives full CRUD, the
  cascade is auto (the universal `entity_data` arm), RBAC/audit are free, `/api/types` serves metadata.
  ZERO Rust. Do NOT write a new module.
- **Add a BUILTIN (typed-table) type**: the `type_definitions` row (`is_builtin = true`) + `type_fields`
  + a migration creating the table (entity-FK'd) + an arm in `type_cache::builtin_table` (same commit as
  the migration) + an arm in `objects::org_builtin` (its reach clause). The generic handler then serves
  it; `registry_display_fields` derives its columns. Only do this when the shape genuinely needs typed
  columns/indexes/existing queries — otherwise prefer the custom (entity_data) path.
- **Add a beyond-CRUD surface a type needs** (a workflow, a typed multi-step flow): a dedicated module
  mirroring `cases.rs` — keep the type `registry_read_only` in objects.rs (browse+delete stay generic),
  put the rich behavior in the module, encode any workflow as DATA (a transition map keyed by a
  discriminator), and REUSE `require_action`/`register_entity`/`grant_owner`/`event::*`/`pipeline`.
- **Add a connector**: a connector is a registered type + a thin transport that calls the framework
  (`pipeline::upload_csv`), NOT the storage layer. The sealed pipeline means it inherits RBAC + audit +
  classification automatically; bypassing it would re-implement (or silently violate) every policy.
- **Add a new cascade parent for an existing type**: add a column name to that type's
  `type_definitions.scope_parents` jsonb (and the column on the table for a builtin). The generated
  `parent_edges_sql` picks it up at cache load — do NOT hand-edit RBAC SQL.

## Shared-symbol seam map (verify before editing)

- **`objects::CASE_REACH`** (`pub(crate) const`) — used in `objects.rs` (the `case` arm of
  `org_builtin`) AND `cases.rs::list`. Change it once, both move.
- **`objects::registry_display_fields`** — used in `objects.rs` (row data: `builtin_view`/`builtin_list`)
  AND `types.rs::payload` (column headers). The FE intersection depends on identical output.
- **`type_cache::parent_edges_sql` / `rbac_with_clause`** — the SOLE copy of the cascade; every RBAC
  consumer (`resolve_grant`, the EDGES introspection, company-of) shares it. Extend via `scope_parents`
  rows, never by editing SQL.
- **`type_cache::builtin_table`** — the ONE place builtin (table, pk) lives; consumed by the cascade
  generator and the generic handler. Extend in the same commit as a builtin's migration.
- **The sealed inserters** — `pipeline::insert_file`/`insert_attachment` are module-private by design.
  Adding a public `db::insert_*` re-opens the bypass class; don't.
- **`field_perms::require_fields` / `matrix` / `tier_index`** — the field gate, shared by
  `objects::builtin_patch`/`builtin_create` and the masking path. `tier_index` aligns `rbac::Role`
  strings with the cell array order (`[owner, admin, member, viewer]`).

## Decisions that are locked (and why) — `docs/decisions/`

- **One canonical table set** (`type_definitions`/`type_fields`/`entity_data`/`field_permissions`) — no
  second `object_types` pair; the generic handler reads it.
- **Hybrid-C storage** — builtins keep typed tables; custom → `entity_data` JSONB (one-polymorphic-table
  + disposability, no `ALTER TABLE` per type). **Polars validates this**: `DataType::Object(name)` sits
  among Polars' typed variants as the type-erased escape hatch — typed-known + one-open-variant (see
  `references/polars-registry-patterns.md`).
- **Unique `rid_prefix` per type** (day-one #1) — never share a prefix; the predecessor's `FIL_`-shared
  dashboard was a permanent id-parsing trap.
- **Derive, don't store** — per-role field cells (from `perm_class`), the read-only registry's display
  columns (from `information_schema`), project stage, report/dashboard slices. A second storage path for
  one concept is a bug.
- **Cascade arms are data** (day-one #6) and **the write path is sealed** (the private inserters) — both
  are Em-level decisions, not refactors.
- **The registry lives in Postgres; cell data lives client-side** (`registry-redundancy.md`) — the
  registry is ids + shape (filenames, counts, a cleanness score, a step recipe), never the contents, so
  the server holds the full recovery store while raw data stays on the device.
