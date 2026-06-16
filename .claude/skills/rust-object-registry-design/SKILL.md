---
name: rust-object-registry-design
description: >-
  Extend RedPash's already-built Rust object registry — the data-driven model where declaring a type
  (a row in type_definitions) auto-wires storage, CRUD, RBAC, audit, and typed fields, and custom
  objects work with zero new code. Use this whenever working on the lean RedPash backend object model:
  adding a new object type, replacing a closed CHECK constraint or Rust enum with a registry row,
  building a new resource surface (like the /api/cases workflow engine), wiring field validation, or
  adding custom-object support — even when the user never says the word "registry". It grounds every
  decision in the registry as it actually ships in `backend/crates/api/src/{objects,types,type_cache,
  cases,pipeline}.rs`, and in the Rust compiler / Postgres / Polars patterns the design rests on, so
  you extend a working system instead of inventing one.
---

# Rust object-registry design

## The idea in one line

A backend stays flexible when **adding a capability is a data insert, not code surgery**. The
rigidity tax is the opposite — a new entity type costing a migration + a new storage module + a new
route module + RBAC wiring + audit wiring. RedPash's north star is *"O(1) in an O(Y) market"*: pay a
one-time framework cost so the next type, vertical, or connector is free. **In the lean rebuild this
is no longer aspirational — the registry is BUILT.** This skill is how you *extend* it correctly,
grounded in the live wiring and in the compiler/Postgres/Polars patterns it mirrors.

## When it applies

Working the backend object model: a new object type, killing a closed `CHECK (… IN (…))` enum, a new
resource surface, wiring field validation, custom objects. If you catch yourself about to write "the
Nth hand-rolled CRUD module", this applies — the answer is almost always *register a type / extend the
generic handler*, not *add a module*.

## What is already built (read this first — do NOT design toward it)

The lean tree (`branch lean` of `redpash-rust-pwa`) shipped the registry. The live wiring, by file:

- **`backend/migrations/20260612000000_init.sql`** — the registry TABLES.
  `type_definitions` (every type is a row: `type_id`, unique `rid_prefix`, `is_builtin`, `grid_served`,
  `scope_parents` jsonb) + `type_fields` (the field catalog: `field`, `ordinal`, `data_type`,
  `perm_class`, `options`, `validate`) + `entity_data` (the polymorphic JSONB store for custom types,
  `scope_parent_id` a **real FK** per day-one #3) + `field_permissions` (sparse per-cell overrides).
  The 9 builtins are seeded at the bottom (`user/company/team/project/file/chart/dashboard/case/
  connection`). A new type is a row, not a migration — that's the whole thesis, already shipped.

- **`backend/crates/api/src/type_cache.rs`** — `TypeDefCache`, loaded once after migrate. Three jobs:
  `is_type`/`rid_prefix`/`object_kind(rid)` (prefix→type via a `HashMap`, day-one #1 unique prefixes),
  `builtin_table(type_id) -> (table, pk)` (the ONE place builtin storage lives), and **the generated
  RBAC cascade**: `type_definitions.scope_parents` rows are compiled into ONE `parent_edges_sql`
  fragment that `rbac_with_clause()` wraps in a recursive `scopes` CTE — every RBAC consumer shares
  exactly one copy of the cascade knowledge, and it came from the DB (day-one #6).

- **`backend/crates/api/src/objects.rs`** — the generic `/api/objects/:type[/:rid]` handler: ONE
  `list/get/create/patch/delete` for every registered type. Custom types flow through `entity_data`
  (JSONB); the **org builtins** (`org_builtin`: user/company/team/file/project/case) dispatch to their
  TYPED tables on the same wire shape (`builtin_list`/`builtin_view`/`builtin_create`/`builtin_patch`).
  Key mechanisms to extend, not reinvent: the `registry_display_fields` DERIVE (read-only registry
  types — file/project/case — derive ALL real columns minus `HIDDEN_COLUMNS`, so the browse view shows
  the whole object with no per-column migration), `CASE_REACH` (`pub(crate) const`, shared with
  `cases.rs` so the two reach predicates can't drift), `registry_read_only` (file/project/case are
  browse + delete only — created/edited by their own flows), and the IDOR guard (a caller-supplied
  `scope_parent_id` must be reachable at ≥ Member, day-one #3).

- **`backend/crates/api/src/types.rs`** — `GET /api/types`, the TypeDefinition contract the FE builds
  grids/editors from. Reads LIVE from the DB (a custom type is "a row, not a migration"; an admin
  override must show on the next GET). Per-role `cells` are DERIVED from `perm_class` then overlaid
  with sparse `field_permissions`. Calls the SAME `objects::registry_display_fields` to append every
  uncataloged real column as a `readonly` display field — so `/types` (column headers) and `/objects`
  (row data) share one field set ("derive, don't store").

- **`backend/crates/api/src/cases.rs`** — the NEWEST worked example: the dedicated `/api/cases`
  surface + the **workflow engine**. Workflows are DATA keyed by `cases.source` (a pure transition map,
  no DB); the status PATCH ENFORCES `to ∈ transitions[from]` → else `422 invalid_transition`, with the
  DB enum CHECK as backstop. Plus attachments (`pipeline::upload_attachment`). This is what to mirror
  when a type needs a dedicated surface the generic handler can't carry (a workflow, a typed
  multi-step flow) — `case` stays `registry_read_only` in objects.rs (browse+delete), and the rich
  behavior lives in its own module that *reuses* the same RBAC + audit + entity registration.

- **`backend/crates/api/src/pipeline.rs`** — the SEALED write path (day-one). `insert_file` and
  `insert_attachment` are **module-private**: there is no public `db::insert_file`/`db::insert_attachment`,
  so the connector-bypass class (a loader inserting a row directly, skipping RBAC + audit) cannot exist
  by visibility, not convention. A new producer calls `upload_csv`/`upload_attachment`, inheriting policy.

The day-one decisions behind all of this live in **`docs/decisions/day-one.md`**; the live doc-to-code
map is **`docs/REDMAP.md`**; the HTTP catalog is **`docs/internal/code/backend/api-routes.md`**. These
are the source of truth for the current direction — point at them rather than re-encoding what they
already hold (so this skill can't re-stale).

## The method

### 1 · Detect the rigidity (the audit lens)

Scan for the tells that something should be a registry row but isn't — each is a place where extension
would cost a redeploy:

- closed `CHECK (col IN ('a','b',…))` constraints, and Rust `enum`s mirrored from them, that grow when
  a vertical/format/type is added;
- a hand-written CRUD module duplicating the generic `list/get/create/patch/delete + RBAC + audit`
  shape that `objects.rs` already provides;
- a hardcoded `Vec`/`&[…]` lookup table that is really a registry;
- `if x in known_list` / an exhaustive `match` over a string set in *framework* code.

A closed enum is only justified when the set is a true, bounded invariant. The lean code is honest
about this line: `rbac::Role { Viewer < Member < Admin < Owner }` is a fixed permission axis (correct
as an enum), and the case `type`/`priority`/workflow `status` sets are deliberately *small const
arrays + the DB CHECK as backstop* (a curated workflow vocabulary, not an open per-vertical set — and
the workflow itself is data keyed by `source`, so the OPEN axis is captured the right way). Anything
that grows per vertical/format/type belongs in `type_definitions`/`type_fields`/`entity_data`.

### 2 · Reuse the built registry — don't invent, EXTEND

The registry is shipped. Reach for the existing wiring before writing anything new:

- **A new custom object type** → INSERT a `type_definitions` row (unique `rid_prefix`,
  `scope_parents` if it cascades) + its `type_fields`. It gets the full generic `/api/objects/:type`
  CRUD, the RBAC cascade (auto, from `scope_parents`), audit events, and `/api/types` metadata — zero
  new Rust. This is the "register a provider" pattern at its purest: the row IS the registration.
- **A new builtin (typed-table) type** → add the `type_definitions` row with `is_builtin = true`, the
  `type_fields` catalog, an arm in `type_cache::builtin_table` (the ONE place builtin storage lives,
  extended in the same commit as the migration per its doc-comment), and an arm in `objects::org_builtin`
  (its reach clause). The generic handler then serves it; `registry_display_fields` derives its columns.
- **A new resource surface a type needs beyond CRUD** (a workflow, a typed flow) → mirror
  **`cases.rs`**: a dedicated module that *reuses* `rbac::require_action`/`require_rule`,
  `db::register_entity` + `db::grant_owner`, `event::*`, and (for files/bytes) the sealed `pipeline`;
  keep the type `registry_read_only` in objects.rs so browse+delete stay generic. Workflows go in as
  DATA (a transition map keyed by a discriminator), never a `match` ladder of hard-coded steps.
- **RBAC for a new type** → free. `resolve_grant`/`require_action` key off principals + membership,
  never the object's type (see `references/postgres-rbac-patterns.md`); the cascade is generated from
  `scope_parents`. Don't write per-type RBAC.
- **The write path for anything that produces a stored artifact** → the **sealed pipeline**. There is
  no public inserter; a new producer calls `pipeline::upload_*`. Don't add a `db::insert_*` — that
  re-opens the bypass class the seal closes.

The closest external precedents for the parts you're extending live in dependencies and the platform
RedPash already runs on: Polars' `DataType::Object(name)` (Hybrid-C in the wild) and the Postgres
`pg_catalog` (the data-driven object registry at DBMS scale). Read those in step 3 — study their shape,
don't import them.

### 3 · Ground the design in proven registries (Postgres first — it's where you store)

Don't re-derive the registration + storage layer from scratch — battle-tested systems already solve
it, and the closest one is the database RedPash stores in. Read these before designing:

- **[`references/postgres-registry-patterns.md`](references/postgres-registry-patterns.md)** — **the
  capstone, and the closest.** Postgres's *system catalog* IS a data-driven object registry:
  `pg_class` ↔ `type_definitions`, `pg_attribute` ↔ `type_fields` (literal), `pg_type` +
  `typinput`/`typoutput` ↔ the per-type-providers pattern, `pg_type.dat` ↔ the builtin seed rows, and
  `jsonb` is *itself a catalog type* ↔ `entity_data`. `CREATE TYPE` = `TypeCreate → CatalogTupleInsert`
  = a row INSERT, no recompile = a new `type_definitions` row. When unsure, ask *how does `pg_catalog`
  do it?*
- **[`references/postgres-rbac-patterns.md`](references/postgres-rbac-patterns.md)** — why a new type
  gets RBAC for free: PG Ch. 22's role model (recursive membership, the capability flag held apart from
  object tiers) is exactly RedPash's `principals` closure + `Role` spine + `is_platform_admin`. The
  cascade RedPash *generates* from `type_definitions.scope_parents` is the data form of PG role
  inheritance.
- **[`references/rustc-registry-patterns.md`](references/rustc-registry-patterns.md)** — the
  *type-system* model. rustc maps almost one-to-one: `DefId` (central id) ↔ `entities`; the query
  system + `Providers` (register a provider, never edit a `match`) ↔ a `type_definitions` row + the
  generic handler; `Symbol`/`Interned` interning ↔ the `TypeDefCache` (and *why* moving builtins from
  `&'static str` to DB rows costs nothing); `TyCtxt` ↔ `AppState`.
- **[`references/polars-registry-patterns.md`](references/polars-registry-patterns.md)** — the *data*
  model, in RedPash's own dependency tree (`polars` **0.54** via the `doumouya/polars-rp` fork in
  `backend/Cargo.toml`). The public API RedPash uses (`DataFrame`/`AnyValue`/`DataType`/`LazyFrame`/
  `Schema`) shows the typed-plus-`DataType::Object(name)` split that **is Hybrid-C in the wild** —
  exactly `entity_data` JSONB alongside the typed builtin tables.
- **[`references/wasm-bindgen-registry-patterns.md`](references/wasm-bindgen-registry-patterns.md)** —
  not a registry to copy but the **constraint that forces** one. RedPash's `data` crate is
  `cdylib + rlib` (one engine, two surfaces) with a type-erased JSON boundary (`data/src/wasm.rs`'s
  `Workbook`), so a compile-time-typed engine would need a recompiled wasm per new type. A data-driven
  registry keeps the wasm blob **stable** while new types are rows ([[wasm-replaces-js]]).

Headline lessons (a compiler, a dataframe engine, a wasm bridge, and a database all agree): a new
capability = **register a row/provider**, never grow a central `match`; keep **typed tables for the
known builtins + one type-erased escape hatch** (`entity_data`) for the open set; hold the registry on
one cheap-to-clone context (`AppState` + `Arc<TypeDefCache>`); a cached registry costs nothing per
access.

### 4 · Decompose, don't big-bang

Even though the registry is built, *extending* it is still a finite sequence of shippable slices, not
an open-ended refactor. For a new type the canonical shape is small: (1) the `type_definitions` +
`type_fields` rows (a migration follow-up, each header carrying the WHY); (2) for a builtin, the
`builtin_table` + `org_builtin` arms; (3) for a beyond-CRUD surface, the dedicated module mirroring
`cases.rs`. Each slice builds + verifies on its own (`sh tools/ci.sh`); back-compat for the existing
builtins is the bar. See `references/redpash-worked-example.md` for the wiring of the types already in.

### 5 · Seam-map before you edit

Reference-map *every* consumer of a symbol before changing it — the recurring failure is drift (a
producer changes, a consumer is missed). The lean tree is a FLAT crate (`backend/crates/api/src/<mod>.rs`
— there is no `routes/` dir), so greps for unique symbol names are reliable; rust-analyzer rooted at
the Cargo workspace (`backend/`, not the session cwd) gives `findReferences`/`rename`. Standing hazards:
`objects::CASE_REACH` is shared by `objects.rs` and `cases.rs` (change it once, both move); the
generated RBAC cascade means the cascade is in exactly one place (`type_cache::parent_edges_sql`) — add
a new cascade arm by adding a `scope_parents` entry to the `type_definitions` row, never by editing SQL
in N consumers; `registry_display_fields` is shared by `objects.rs` (row data) and `types.rs` (column
headers), so the FE's column ⋂ row-keys intersection depends on them staying identical.

### 6 · Storage = hybrid (already the shape)

Builtins keep their typed tables (typed columns, indexes, existing queries); **custom** types land in
the one polymorphic `entity_data (… data JSONB)` table, `type_id → type_definitions ON DELETE RESTRICT`,
`scope_parent_id → entities ON DELETE SET NULL` (a real FK, day-one #3). This honors the locked
one-polymorphic-table object model + disposability without an `ALTER TABLE` per new type. JSONB here
isn't a workaround — it's Postgres's *own* catalog escape hatch (`jsonb` is a row in `pg_type`), so
`entity_data` uses the same typed-plus-one-open-type split `pg_catalog` itself ships.

## The references

- [`references/postgres-registry-patterns.md`](references/postgres-registry-patterns.md) — **read for
  step 3 first**: the capstone — Postgres's `pg_catalog` is the data-driven object registry RedPash
  mirrors (`pg_class`/`pg_attribute`/`pg_type`; `CREATE TYPE` = INSERT; `jsonb` as the escape hatch).
- [`references/postgres-rbac-patterns.md`](references/postgres-rbac-patterns.md) — **the RBAC half**:
  PG Ch. 22 role model → RedPash's type-agnostic `resolve_grant` + the generated cascade. Why a new
  type gets RBAC for free.
- [`references/rustc-registry-patterns.md`](references/rustc-registry-patterns.md) — the rustc →
  RedPash mapping (the type-system model: `DefId`/`Providers`/`Interner`/`TyCtxt`), source-pointed.
- [`references/polars-registry-patterns.md`](references/polars-registry-patterns.md) — the Polars →
  RedPash mapping (the data model, an in-`Cargo.toml` dependency at 0.54): `DataType::Object` =
  Hybrid-C; `AnyValue`/`Schema` = the dynamic value + runtime field set.
- [`references/wasm-bindgen-registry-patterns.md`](references/wasm-bindgen-registry-patterns.md) — the
  two-surface constraint: why a data-driven registry is *required* (not just nicer) so the `cdylib+rlib`
  engine's wasm blob stays stable across an open type set.
- [`references/rust-idioms.md`](references/rust-idioms.md) — the Rust Book chapters each registry
  decision rests on (open-vs-closed = trait objects/data rows vs enums; error handling; modules).
- [`references/redpash-worked-example.md`](references/redpash-worked-example.md) — **the concrete
  output of this method on the LIVE lean backend**: the as-built registry wiring (objects/types/
  type_cache/cases/pipeline), the exact extension recipes (add a custom type / a builtin / a workflow
  surface), and the shared-symbol seam map. Read it to see what "done" looks like and to lift the exact
  call sites.

## Related skills

- **`redpash-polars`** (repo) — writing/editing the `data` crate (polars 0.54 + the `polars-rp` fork)
  the objects' cell data flows through: `LazyFrame` pipelines, `AnyValue` cell matching, `Workbook`'s
  JSON/wasm boundary. The "type-erased handle → concrete type" pattern is shared; this skill *designs*
  the registry, that one *operates* the engine.
- The general **`rust`** / **`rust-best-practices`** skills — the idiomatic + compiler-as-oracle
  baseline (ownership, errors, the verify loop) this skill assumes.
