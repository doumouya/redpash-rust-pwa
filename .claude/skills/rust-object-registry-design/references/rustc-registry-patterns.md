# rustc → RedPash: the registry patterns the design rests on

The Rust compiler solves *exactly* RedPash's problem — a single, extensible registry of typed objects
with stable ids, demand-driven behavior, and zero per-access cost — and has done so at the scale of the
entire language for a decade. Each pattern below is pinned to its source in the `rust-lang/rust` tree
and mapped to the RedPash seam it informs. The lean tree already implements these shapes; study the
rustc file when a mapping isn't obvious — the point is to recognize the **proven shape**, not to imitate
the compiler's complexity (lifetimes/arenas are theirs to amortize, not ours).

---

## 1 · Stable id for every object — `DefId`

**rustc** — `compiler/rustc_span/src/def_id.rs`

```rust
pub struct DefId { pub index: DefIndex, pub krate: CrateNum }   // DefIndex is a newtype_index! (u32)
```

Every definition the compiler knows — every fn, struct, const, module — gets one `DefId` in a single
central index, namespaced by crate. Everything downstream keys off it. There is no per-kind id space;
*one* handle addresses *any* definition.

**RedPash analog** — the `entities(id, type)` table + `db::register_entity(&mut tx, rid, type)`, called
before every subtype insert (the create tx in `objects.rs`, `cases.rs`, `pipeline.rs::insert_file`, …).
Every top-level object's PK FKs into `entities` `ON DELETE CASCADE` — one delete path, polymorphic edges
cascade-safe for free.

**Lesson** — the polymorphic id space is the correct foundation, and RedPash has it. A custom type
doesn't need a new id scheme; it registers an `entities` row like everything else. Don't add a parallel
id space per type — that's the mistake `DefId` exists to prevent.

---

## 2 · Open registration — the query system + `Providers`

**rustc** — `compiler/rustc_middle/src/query/mod.rs` (`pub use crate::queries::Providers;`),
populated in `compiler/rustc_interface/src/passes.rs`:

```rust
pub static DEFAULT_QUERY_PROVIDERS: LazyLock<Providers> = LazyLock::new(|| {
    let providers = &mut Providers::default();
    providers.queries.analysis           = analysis;
    providers.queries.hir_crate          = rustc_ast_lowering::lower_to_hir;
    // … every capability assigns its implementation fn into the open struct
});
```

`Providers` is a default-constructed struct of function pointers; each capability *registers its impl*
by assigning a field. Adding a query never edits a central `match` — you provide a function. Each query
also declares its **cache strategy** by key type (`query/keys.rs`), so lookups are memoized per key.

**RedPash analog** — this is the shape RedPash shipped: declaring a type is INSERTing a
`type_definitions` row, and the generic `objects.rs` handler dispatches off it (storage via
`type_cache::builtin_table`/`org_builtin`, RBAC via the generated cascade, field set via `type_fields`)
— never a per-type `match`. The case workflow is the same idea at the value level: `cases.rs`'s
`mod workflow` is a transition map (`[(state, &[next])]`) keyed by `source`, so a new workflow is data,
not a new `match` arm. (The lean code keeps the small, curated state vocabularies as const arrays + the
DB CHECK as backstop — the OPEN axis is the workflow *table*, not the state names.)

**Lesson** — extensibility = *register a row/provider*, not *edit the dispatcher*. The "open struct of
impls / open table of rows" is the antidote to the `if x in known_list` tax.

---

## 3 · Why DB-loaded registries cost nothing — interning

**rustc** — string interner `compiler/rustc_span/src/symbol.rs`:

```rust
pub struct Symbol(SymbolIndex);                 // a u32 handle, not a string
pub fn intern(str: &str) -> Self { … }          // string  → interned id
fn prefill(init: &[&'static str], extra: &[&'static str]) -> Self { … }   // ← the key line
```

and the value interner `compiler/rustc_data_structures/src/intern.rs`:

```rust
pub struct Interned<'a, T>(pub &'a T, PrivateZst);   // equality + hashing by ADDRESS, not contents
```

rustc never compares types or symbols by their contents on the hot path — it interns them once and then
compares/copies cheap handles. Crucially, `Interner::prefill` seeds the table with `&'static str`
builtins **and** extends it with runtime strings — the same table holds both.

**RedPash analog** — the `TypeDefCache` (`type_cache.rs`): loaded once at startup from
`type_definitions`, holding `by_type`/`by_prefix` `HashMap`s, extended by custom types (which are just
more rows). `type_id`/`rid_prefix` keys behave like interned symbols (`object_kind(rid)` is a prefix
lookup, not a scan — the predecessor's linear scans were the hot path the lean cache removed).

**Lesson** — moving the builtins from `&'static str` literals into DB rows is not a performance
regression: load/cache once at startup, then look up by id. The `prefill(builtins, custom)` signature is
literally the "seed the 9 builtins (the migration) + load any custom types" design — and the seeding is
exactly what the init migration's `INSERT INTO type_definitions …` does.

---

## 4 · One central, cheap context — `TyCtxt` / `GlobalCtxt`

**rustc** — `compiler/rustc_middle/src/ty/context.rs`:

```rust
pub struct GlobalCtxt<'tcx> {        // "The central data structure of the compiler."
    interners: CtxtInterners<'tcx>,  // all the interned registries
    // … queries, caches, arenas …
}
pub struct TyCtxt<'tcx> { /* a Copy handle to &GlobalCtxt */ }
```

Every registry lives on one `GlobalCtxt`; `TyCtxt` is a trivially-`Copy` handle threaded through every
function. No scattered global statics — one context, passed explicitly, cheap to pass.

**RedPash analog** — `AppState` holding `Arc<TypeDefCache>` (+ the db pool). Handlers read
`state.type_cache` (cheap), never reach for a global. The cache is loaded after migrate, in the
migrate → seed → cache order.

**Lesson** — put the registry on the context you already thread (`AppState`), behind an `Arc` so clones
are free, and keep read-guards off `.await` points. The cache is read-mostly, computed once at boot.

---

## 5 · When a closed enum is RIGHT — the bounded invariant

Not everything should be a registry. rustc keeps closed enums where the set is a genuine, small,
language-level invariant (e.g. `Mutability { Not, Mut }`, the primitive int widths). The RedPash twin is
the RBAC tier `rbac::Role { Viewer < Member < Admin < Owner }` — four tiers are the framework's
permission *axis*, not a per-type list, so the enum is correct (`rbac::Action` likewise). What is *not*
a true invariant: the set of object types (→ `type_definitions` rows), a type's field set (→
`type_fields`), the case *workflow* (→ the transition map keyed by `source`). The case `status`/`type`/
`priority` const arrays are an in-between deliberate choice: a small curated vocabulary with the DB CHECK
as backstop, where the open axis (which workflow) is the data, not the state names.

**Lesson** — registry vs enum is the open-vs-closed decision (see `references/rust-idioms.md`). Ask:
"does a new vertical/type/format add a value here?" Yes → registry row. No, it's a fixed axis → enum.

---

## Quick map

| rustc | source | RedPash seam | as-built |
|---|---|---|---|
| `DefId` central id | `rustc_span/src/def_id.rs` | `entities` + `db::register_entity` | shipped |
| query `Providers` (open reg) | `rustc_interface/src/passes.rs` | `type_definitions` row + generic `objects.rs` handler | shipped |
| query cache by key | `rustc_middle/src/query/keys.rs` | `TypeDefCache` `HashMap` lookups | shipped |
| `Symbol`/`Interned` | `rustc_span/src/symbol.rs`, `rustc_data_structures/src/intern.rs` | `TypeDefCache` (`by_type`/`by_prefix`); DB rows over `&'static str` is safe | shipped |
| `Interner::prefill(builtins, extra)` | `rustc_span/src/symbol.rs` | seed builtins (the migration) + load custom rows | shipped |
| `GlobalCtxt`/`TyCtxt` | `rustc_middle/src/ty/context.rs` | `AppState` + `Arc<TypeDefCache>` | shipped |
| closed enum (bounded invariant) | `rbac::Role`/`Action` | keep tiers closed; types/fields/workflows → data | shipped |
