# rustc → RedPash: the registry patterns to copy

The Rust compiler solves *exactly* our problem — a single, extensible registry of typed objects with
stable ids, demand-driven behavior, and zero per-access cost — and has done so at the scale of the
entire language for a decade. Each pattern below is pinned to its source in the `rust-lang/rust` tree
(the `rust-rp-main.zip` snapshot) and mapped to the RedPash seam it informs. Study the rustc file when
the mapping isn't obvious; the point is to **lift a proven shape**, not to imitate the compiler's
complexity (lifetimes/arenas are theirs to amortize, not ours).

---

## 1 · Stable id for every object — `DefId`

**rustc** — `compiler/rustc_span/src/def_id.rs:242`

```rust
pub struct DefId { pub index: DefIndex, pub krate: CrateNum }   // DefIndex is a newtype_index! (u32)
```

Every definition the compiler knows — every fn, struct, const, module — gets one `DefId` in a single
central index, namespaced by crate. Everything downstream (types, queries, diagnostics) keys off it.
There is no per-kind id space; *one* handle addresses *any* definition.

**RedPash analog** — the `entities(id, type)` table + `register_entity(ex, id, type)` (`db/entities.rs:21`),
called before every subtype insert (7 sites: company/project/case/team/file-via-project/connection/user).

**Lesson** — the polymorphic id space is the correct foundation, and RedPash already has it. A custom
type doesn't need a new id scheme; it registers an `entities` row like everything else. Don't add a
parallel id space per type — that's the mistake `DefId` exists to prevent.

---

## 2 · Open registration — the query system + `Providers`

**rustc** — `compiler/rustc_middle/src/query/mod.rs` (`pub use crate::queries::Providers;`),
populated in `compiler/rustc_interface/src/passes.rs:877`:

```rust
pub static DEFAULT_QUERY_PROVIDERS: LazyLock<Providers> = LazyLock::new(|| {
    let providers = &mut Providers::default();
    providers.queries.analysis           = analysis;
    providers.queries.hir_crate          = rustc_ast_lowering::lower_to_hir;
    providers.queries.resolver_for_lowering_raw = resolver_for_lowering_raw;
    // … every capability assigns its implementation fn into the open struct
});
```

`Providers` is a default-constructed struct of function pointers; each capability *registers its impl*
by assigning a field. Adding a query never edits a central `match` — you provide a function. Each query
also declares its **cache strategy** by key type (`query/keys.rs`: `type Cache<V> = DefIdCache<V>` /
`DefaultCache` / `VecCache` / `SingleCache`), so lookups are memoized per key.

**RedPash analog** — this is the shape RedPash *already* uses in two places:
`validate_rules::RuleRegistry` (`register(Rule { kind, check })` into a `HashMap`) and `codec_registry`
(codecs self-register at startup). The same shape generalizes to **`register_type`**: declaring a
TypeDefinition registers its providers (storage, field set, RBAC defaults, audit kind), and the generic
handler dispatches through them — never a per-type `match`.

**Lesson** — extensibility = *register a provider*, not *edit the dispatcher*. When you design
`register_type` (Stage 3), model it on `Providers`: a default set for builtins, runtime registration for
custom types, lookup by key. The "open struct of impls" is the antidote to the `if x in known_list` tax.

---

## 3 · Why DB-loaded registries cost nothing — interning

**rustc** — string interner `compiler/rustc_span/src/symbol.rs`:

```rust
pub struct Symbol(SymbolIndex);                 // a u32 handle, not a string
pub fn intern(str: &str) -> Self { … }          // string  → interned id
pub(crate) struct Interner(Lock<InternerInner>);
fn prefill(init: &[&'static str], extra: &[&'static str]) -> Self { … }   // ← the key line
```

and the value interner `compiler/rustc_data_structures/src/intern.rs:26`:

```rust
pub struct Interned<'a, T>(pub &'a T, PrivateZst);   // equality + hashing by ADDRESS, not contents
```

rustc never compares types or symbols by their contents on the hot path — it interns them once (dedup
to a unique location) and then compares/copies cheap handles. Crucially, `Interner::prefill` seeds the
table with `&'static str` builtins **and** extends it with runtime strings — the same table holds both.

**RedPash analog** — the `type_definitions` cache (`Arc<TypeDefCache>` loaded once at startup, seeded
from the builtins, extended by custom types). `type_id`/`field` keys behave like interned symbols.

**Lesson** — this is the direct answer to the `&'static str → String` worry in the seam map. rustc's
own builtins are `&'static str` *and* it adds runtime strings to the same interner — so moving RedPash
builtins from `&'static str` literals into DB rows is not a performance regression: intern/cache once at
startup, then compare by id. The `prefill(builtins, custom)` signature is literally Stage 1's
"seed the 7 builtins + load custom types" design.

---

## 4 · One central, cheap context — `TyCtxt` / `GlobalCtxt`

**rustc** — `compiler/rustc_middle/src/ty/context.rs:684` / `:661`:

```rust
pub struct GlobalCtxt<'tcx> {        // "The central data structure of the compiler."
    interners: CtxtInterners<'tcx>,  // all the interned registries
    untracked: Untracked,            // the side stores
    // … queries, caches, arenas …
}
pub struct TyCtxt<'tcx> { /* a Copy handle to &GlobalCtxt */ }
```

Every registry lives on one `GlobalCtxt`; `TyCtxt` is a trivially-`Copy` handle threaded through every
function. No scattered global statics — one context, passed explicitly, cheap to pass.

**RedPash analog** — `AppState` holding `Arc<TypeDefCache>` (+ the db pool). Handlers clone the `Arc`
(cheap), read the registry, never reach for a global. This is the Stage 1 cache placement.

**Lesson** — put the registry on the context you already thread (`AppState`), behind an `Arc` so clones
are free. Keep read-guards off `.await` points (use a sync scope or `tokio::sync::RwLock`) — the cache
is read-mostly, written only when a custom type is registered.

---

## 5 · When a closed enum is RIGHT — the bounded invariant

Not everything should be a registry. rustc keeps closed enums where the set is a genuine, small,
language-level invariant (e.g. `Mutability { Not, Mut }`, the primitive int widths). The RedPash twin is
the RBAC tier `Role { Viewer < Member < Admin < Owner }` (`rbac.rs:26`) — four tiers are the framework's
permission *axis*, not a per-type list, so the enum is correct. What is *not* a true invariant: the set
of object types, case statuses, team kinds, per-scope role allow-lists — those grow per vertical and
belong in data.

**Lesson** — registry vs enum is the open-vs-closed decision (see `references/rust-idioms.md`). Ask:
"does a new vertical/type/format add a value here?" Yes → registry. No, it's a fixed axis → enum.

---

## Quick map

| rustc | source | RedPash seam | stage |
|---|---|---|---|
| `DefId` central id | `rustc_span/src/def_id.rs:242` | `entities` + `register_entity` | foundation (have it) |
| query `Providers` (open reg) | `rustc_interface/src/passes.rs:877` | `RuleRegistry`/`codec` → `register_type` | 2–3 |
| query cache by key | `rustc_middle/src/query/keys.rs` | per-type cache strategy | 2–3 |
| `Symbol`/`Interned` | `rustc_span/src/symbol.rs`, `rustc_data_structures/src/intern.rs:26` | `type_definitions` cache; `&'static str→String` is safe | 1 |
| `Interner::prefill(builtins, extra)` | `rustc_span/src/symbol.rs:2722` | seed builtins + load custom | 1 |
| `GlobalCtxt`/`TyCtxt` | `rustc_middle/src/ty/context.rs:684` | `AppState` + `Arc<TypeDefCache>` | 1 |
| closed enum (bounded invariant) | `rbac.rs:26` `Role` | keep tiers closed; types/statuses → data | 1 |
