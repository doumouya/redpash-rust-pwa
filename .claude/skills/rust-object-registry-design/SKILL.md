---
name: rust-object-registry-design
description: >-
  Design or extend a Rust backend as a DATA-DRIVEN OBJECT REGISTRY — where declaring a type
  auto-wires storage, CRUD, RBAC, audit, and typed fields, and users can define custom objects
  with zero code changes. Use this whenever working on the RedPash backend object model: adding a
  new entity/object type, replacing a closed CHECK constraint or Rust enum with a registry table,
  collapsing repeated hand-written CRUD route modules into one generic handler, wiring field
  validation, or building custom-object support — even when the user never says the word
  "registry". It grounds every decision in the Rust compiler's own proven extensible-registry
  patterns (DefId, the query system + Providers, interners, TyCtxt) and in the seams that already
  exist in this codebase, so you extend a working pattern instead of inventing one.
---

# Rust object-registry design

## The idea in one line

A backend stays flexible when **adding a capability is a data insert, not code surgery**. The
opposite — a new entity type costing a migration + a new `db/` module + a new `routes/` module +
RBAC wiring + audit wiring — is the rigidity tax. RedPash's north star is *"O(1) in an O(Y) market"*:
pay a one-time framework cost so the next type, vertical, or connector is free. This skill is how you
get there in Rust, without inventing anything — the compiler and this codebase already show the way.

## When it applies

Designing/extending the backend object model: a new object type, killing a closed `CHECK (… IN (…))`
enum, collapsing N near-identical CRUD handlers, wiring `validate_rules`, or user-defined custom
objects. If you catch yourself about to write "the Nth hand-rolled version of X", this applies.

## The method

### 1 · Detect the rigidity (the audit lens)

Scan for the tells that a registry is missing — each is a place where extension costs a redeploy:

- closed `CHECK (col IN ('a','b',…))` constraints, and Rust `enum`s mirrored from them;
- **N parallel hand-written CRUD modules** (`routes/{companies,projects,cases,…}.rs`) repeating the
  same `list/get/create/patch/delete + RBAC + audit` shape;
- **code-baked registries** — a hardcoded `Vec`/`&[…]` that is really a lookup table
  (`field_perms::default_registry()`, `type_registry::builtin_meta()`);
- per-scope const arrays (`PROJECT_ROLES` ≠ `COMPANY_ROLES`);
- any `if x in known_list` / exhaustive `match` over a string set in *framework* code.

A closed enum is only justified when the set is a true invariant (see the `Role` tier below). Anything
that grows when a vertical/format/type is added is debt.

### 2 · Apply the seeds already in this codebase — don't invent

This backend already contains the registry pattern in working form. Reuse, don't reinvent:

- `codec_registry` — **open registry, shipped**: `data_type` is a `String`, codecs self-register at
  startup, a new format is zero source edits. This is the reference shape.
- `validate_rules::RuleRegistry` — an open `HashMap<kind, fn>` (`register()` adds a rule kind; the
  pipeline never grows a `match`). Fully built + tested; wired at `routes/demo.rs:217`.
- `members.rs` — **one polymorphic module** nested under `/:rid/members` on every object type. Proof
  a generic resource handler works here.
- `rbac::resolve_grant(pool, caller, object)` — type-agnostic RBAC over any object id (keyed on
  principals + membership, never the object's type), so new types get RBAC for free. This is modelled on
  Postgres's role system — see [`references/postgres-rbac-patterns.md`](references/postgres-rbac-patterns.md).
- `entities` + `register_entity(ex, id, type)` — the one polymorphic id space; every subtype FKs in
  `ON DELETE CASCADE`.

The closest precedents for the parts not yet built live in **Polars (a dependency)**: `DataType::Object(name)`
(public API) is Hybrid-C in the wild, and the `polars-core`-internal `ObjectRegistry` is the model for
`register_type` — study its shape, don't import it (see step 3).

### 3 · Ground the design in proven registries (Postgres first — it's where you store)

Don't invent the registration + storage layer — battle-tested systems already solve it, and the closest one is
the database RedPash already stores in. Read these before designing:

- **[`references/postgres-registry-patterns.md`](references/postgres-registry-patterns.md)** — **the capstone,
  and the closest.** RedPash stores in Postgres, whose *system catalog* IS a data-driven object registry:
  `pg_class` ↔ `type_definitions`, `pg_attribute` ↔ `type_fields` (literal), `pg_type` + `typinput`/`typoutput`
  ↔ the Providers pattern, `pg_type.dat` ↔ `seed_builtins`, and `jsonb` is *itself a catalog type* ↔ `entity_data`.
  `CREATE TYPE` = `TypeCreate → CatalogTupleInsert` = a row INSERT, no recompile = `register_type`. When unsure,
  ask *how does `pg_catalog` do it?*
- **[`references/rustc-registry-patterns.md`](references/rustc-registry-patterns.md)** — the *type-system*
  model. rustc maps almost one-to-one: `DefId` (central id) ↔ `entities`; the query system + `Providers`
  (register a provider, never edit a `match`) ↔ `register_type`; `Symbol`/`Interned` interning ↔ the cache
  (and *why* `&'static str → String` is safe); `TyCtxt` ↔ `AppState`.
- **[`references/polars-registry-patterns.md`](references/polars-registry-patterns.md)** — the *data* model,
  in RedPash's own dependency tree (`polars` 0.43 in `Cargo.toml`; API ref https://docs.rs/polars/latest/polars/).
  Two layers: the **public API you already use** (`DataFrame`/`AnyValue`/`DataType`/`Expr`/`Schema` via
  `polars::prelude`) shows the typed-plus-`DataType::Object(name)` split that **is Hybrid-C in the wild**; and the
  **`polars-core`-internal `ObjectRegistry`** (`register_object_builder`/`get_object_builder` behind a
  `LazyLock<RwLock<Option<…>>>` — the exact `TypeDefCache` shape) which you *study as a model* for `register_type`
  (it's not a public import — mirror its shape, don't call it). Read `registry.rs` first when designing
  `register_type` + the storage split.
- **[`references/wasm-bindgen-registry-patterns.md`](references/wasm-bindgen-registry-patterns.md)** — not a
  registry to copy but the **constraint that forces** one. RedPash's `data` crate is `cdylib + rlib` (one
  engine, two surfaces) with a type-erased **JSON boundary** (`data/src/wasm.rs`, `frontend/wasm/data.js`), so a
  compile-time-typed engine would need a recompiled ~12 MB wasm per new type. A data-driven registry keeps the
  wasm blob **stable** while new types are rows — this is *why* the design is non-negotiable, not just nicer
  ([[wasm-replaces-js]]).

Headline lessons (all four agree — a compiler, a dataframe engine, a wasm bridge, and a database): a new
capability = **register a provider**, never grow a central `match`;
keep **typed for the known set + one type-erased escape hatch** for the open set; hold the registry on one
cheap-to-clone context; an interned/cached registry costs nothing per access.

### 4 · Stage the work (decompose, don't big-bang)

An open-ended "make it all data-driven" refactor is itself a debt trap; it converges only as a finite
sequence of shippable slices. The canonical arc (see the worked example):

0. **Wire the open validator to one field** — cheapest proof the pipeline works end-to-end (~20 LOC).
1. **Registries → data** — move the hardcoded `Vec` lookups into `type_definitions` tables, seeded
   byte-identically from the builtins.
2. **Generic resource handler** — one `resource(type)` router (generalize `members.rs`) +
   `/api/objects/:type/:rid`.
3. **`register_type` + `entity_data`** — declaring a type auto-provisions storage/CRUD/RBAC/audit;
   custom objects work day one.

Each stage builds + verifies on its own; back-compat for the existing builtin types is the bar.

### 5 · Seam-map before you edit

Reference-map *every* consumer of a symbol before changing it — the registry refactor's recurring
failure is class-drift (a producer changes, a consumer is missed). Use rust-analyzer **rooted at the
Cargo workspace** (`backend/`, not the session cwd — otherwise it indexes nothing and returns no
references) for `findReferences`/`rename`; fall back to grep for unique names. Two standing hazards:
keep `GRANT_SQL` and `EDGES_SQL` in sync (enforcement ↔ audit), and watch the `&'static str → String`
blast radius when a registry moves from code to DB (the interner lesson makes this cheap, not scary).

### 6 · Storage = hybrid

Builtins keep their typed tables (typed columns, indexes, existing queries); **custom** types land in
one polymorphic `entity_data (… data JSONB)` table with `type_id → type_definitions ON DELETE
RESTRICT`. This honors the locked one-polymorphic-table object model + disposability without an
`ALTER TABLE` per new type. JSONB here isn't a workaround — it's Postgres's *own* catalog escape hatch
(`jsonb` is a row in `pg_type`), so `entity_data` uses the same typed-plus-one-open-type split `pg_catalog`
itself ships.

## The references

- [`references/postgres-registry-patterns.md`](references/postgres-registry-patterns.md) — **read for step 3
  first**: the capstone — Postgres's `pg_catalog` is the data-driven object registry RedPash mirrors
  (`pg_class`/`pg_attribute`/`pg_type`; `CREATE TYPE` = INSERT; `jsonb` as the escape hatch).
- [`references/postgres-rbac-patterns.md`](references/postgres-rbac-patterns.md) — **read for the RBAC half**:
  PG Ch. 22 role model → RedPash RBAC (recursive membership ↔ the `principals` closure; `SUPERUSER` ↔
  `is_platform_admin`; `ADMIN OPTION` ↔ the ≥Admin membership gate; `SECURITY DEFINER` ↔ `as_user` run-as).
  Why a new type gets RBAC for free.
- [`references/rustc-registry-patterns.md`](references/rustc-registry-patterns.md) — **read for step 3**:
  the rustc → RedPash mapping (the type-system model), source-pointed.
- [`references/polars-registry-patterns.md`](references/polars-registry-patterns.md) — **read for step 3**:
  the Polars → RedPash mapping (the data model, an in-`Cargo.toml` dependency). The closest working precedent
  for `register_type` (`ObjectRegistry`, polars-core-internal exemplar) + Hybrid-C (`DataType::Object`, public).
- [`references/wasm-bindgen-registry-patterns.md`](references/wasm-bindgen-registry-patterns.md) — **read for
  step 3**: the two-surface constraint — why a data-driven registry is *required* (not just nicer) so the
  `cdylib+rlib` engine's wasm blob stays stable across an open type set.
- [`references/rust-idioms.md`](references/rust-idioms.md) — the specific Rust Book chapters each
  registry decision rests on (open-vs-closed = trait objects vs enums, error handling, modules).
- [`references/redpash-worked-example.md`](references/redpash-worked-example.md) — the concrete output
  of this method on the live backend: the reference-verified seam map + the staged 0→3 arc. Read it to
  see what "done" looks like and to lift the exact call-site counts.

## Related skills

- **`rust-data-engine`** (repo) — working the `data` crate the objects flow through (Polars `LazyFrame`/`col()`,
  the `Series`↔`ChunkedArray<T>` type model, the JSON/wasm boundary). The "type-erased handle → concrete type"
  pattern is shared; this skill *designs* the registry, that one *operates* the engine.
- The general **`rust`** skill (if installed) — the idiomatic + compiler-as-oracle baseline (ownership, errors,
  the verify loop) this skill assumes.
