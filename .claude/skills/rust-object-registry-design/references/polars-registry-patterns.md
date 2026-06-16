# Polars → RedPash: the in-dependency registry exemplar

rustc (`references/rustc-registry-patterns.md`) is the type-*system* model; **Polars is the data model** —
and RedPash already links Polars (`backend/Cargo.toml`: **polars 0.54** via the `doumouya/polars-rp`
fork — `git rev 0bb178d6…`; the fork gates tokio off wasm so polars-core compiles to
`wasm32-unknown-unknown`, the "one engine, two surfaces" requirement). The cell data of every object
flows through Polars in `pipeline.rs` and the whole `data` crate. Keep two layers straight:

- **Public API RedPash imports today** — via `polars::prelude` (API ref: https://docs.rs/polars/0.54.0/polars/):
  `DataFrame`, `Series`/`Column`, `Expr`/`LazyFrame`, `AnyValue`, `DataType`, `Schema`. Directly usable —
  `pipeline.rs` parses to a `DataFrame`; `data::group_by`/`filter`/`sort`/`sql` drive `LazyFrame`
  pipelines; cell matching uses `AnyValue`. The `redpash-polars` skill documents the exact 0.54 surface.
- **Internal mechanism to STUDY, not import** — `ObjectRegistry` (below) lives in `polars-core`
  internals and is **not re-exported through the `polars` facade**, so it's a design *exemplar* you read
  in the source, not a library call. It's still in RedPash's dependency tree, and it's the closest
  working precedent for the shape of a runtime type registry.

Source pointers are into the Polars source tree (the `polars-rp` fork tracks upstream `main` for these
long-stable core APIs); the public-API companion is https://docs.rs/polars/0.54.0/polars/. Only the exact
line numbers track the source; the patterns hold across the 0.43→0.54 range RedPash moved through.

---

## 1 · The headline — Polars' runtime `ObjectRegistry` (internal exemplar — study, don't import)

**Polars** — `crates/polars-core/src/chunked_array/object/registry.rs` (a `polars-core` internal; not in
the public `polars` facade — read it as a design model). The module's own opening line:
*"a heap allocated utility that can be used to register an object type. That object type will know its
own generic type parameter `T` and callers can simply send `&Any` values and don't have to know the
generic type themselves."*

```rust
pub struct ObjectRegistry {
    pub builder_constructor: BuilderConstructor,   // Box<dyn Fn(PlSmallStr, usize) -> Box<dyn AnonymousObjectBuilder> + Send + Sync>
    object_converter:  Option<ObjectConverter>,    // AnyValue -> Box<dyn Any> of the object type
    pyobject_converter: Option<PyObjectConverter>,
    pub physical_dtype: ArrowDataType,
    array_getter: ObjectArrayGetter,               // (&dyn Array, usize) -> Option<AnyValue>
    with_gil: WithGIL,
}

static GLOBAL_OBJECT_REGISTRY: LazyLock<RwLock<Option<ObjectRegistry>>> = LazyLock::new(Default::default);

pub fn register_object_builder(builder_constructor, object_converter, …) {
    let mut reg = GLOBAL_OBJECT_REGISTRY.write().unwrap();
    *reg = Some(ObjectRegistry { builder_constructor, … });        // register
}
pub fn get_object_builder(name: PlSmallStr, capacity: usize) -> Box<dyn AnonymousObjectBuilder> {
    let reg = GLOBAL_OBJECT_REGISTRY.read().unwrap();
    (reg.as_ref().unwrap().builder_constructor)(name, capacity)    // materialize by name
}

/// "This trait can be registered, after which that global registration can be used to materialize object types"
pub trait AnonymousObjectBuilder: ArrayBuilder { /* append &Any, finish() -> Series */ }
```

**RedPash analog** — this is the shape of the registry RedPash *already shipped*, one level up:
- `ObjectRegistry` (a struct keyed by a type NAME) ↔ a `type_definitions` row + the generic
  `objects.rs` handler. rustc's `Providers` is the compiler twin; Polars shows it for *data objects*.
- `register_object_builder()` / `get_object_builder(name, …)` ↔ INSERT a `type_definitions` row /
  look-up-by-`type_id` then dispatch (the live `TypeDefCache.get(type_id)` + `org_builtin(type_id)`).
- `AnonymousObjectBuilder` registered → materialize via `&Any` ↔ custom objects handled generically
  without the handler knowing the concrete type (RedPash's `entity_data` JSONB rows).

**Lesson** — the shape RedPash uses is *proven inside its own dependency*: a global registry of
type→behavior, `register_*` to install, lookup-by-name to dispatch. Note Polars independently lands on
**`LazyLock<RwLock<Option<…>>>`** — the read-mostly/write-on-register access pattern that confirms
RedPash's `Arc<TypeDefCache>` placement (load once, read on the hot path). When extending the registry,
this is the precedent — not a bespoke design.

---

## 2 · The typed-vs-erased split — `DataType::Object` validates Hybrid-C

**Polars** — `crates/polars-core/src/datatypes/dtype.rs`:

```rust
pub enum DataType {
    Boolean, Int64, /* … */ String,        // typed, known-at-compile-time variants
    List(Box<DataType>),
    Struct(Vec<Field>),
    Object(&'static str),                   // the type-erased escape hatch (carries a type NAME)
    Null, Categorical(…), /* … */
}
```

Polars keeps **fast typed variants for known shapes** and **one `Object(name)` escape hatch** for types
the engine didn't bake in — exactly RedPash's **Hybrid-C** storage decision: builtins keep their typed
tables; custom types live as a named, type-erased `entity_data` row. Polars proves you don't choose
between "all typed" and "all dynamic" — you keep typed for the hot known set and add one open variant.
(`Object` even carries a `&'static str` name — the same interning lesson from rustc: the type label is
an interned handle.)

**RedPash analog** — `DataType::Object(name)` ↔ `entity_data(type_id, … data JSONB)` alongside the typed
`users`/`companies`/`projects`/… tables. The 9 builtins stay typed; custom types are `Object`-equivalent.

---

## 3 · Type-erased values + dynamic schema

- **`AnyValue`** — `crates/polars-core/src/datatypes/any_value.rs` (`pub enum AnyValue<'a>`): a
  type-erased, borrow-or-owned dynamic value used to move data across the typed/untyped boundary. ↔ the
  JSONB cell values in `entity_data` — one value type that can hold any field's data without a per-type
  Rust struct. (RedPash matches `AnyValue` in `data/src` for cell-level cleaning/sentinels.)
- **`Schema`** — `crates/polars-core/src/schema/mod.rs` (`pub type Schema = polars_schema::Schema<DataType>`):
  an *ordered* name→dtype map; `SchemaRef = Arc<Schema>`. A schema is data — built/extended at runtime,
  not a compile-time struct. ↔ `type_definitions` + `type_fields`: a type's field set is rows, queried at
  runtime (and the read-only registry types DERIVE extra display fields from `information_schema` at GET
  time — see `objects::registry_display_fields`).

---

## 4 · Declarative plan + extensible API surface

- **`Expr` / LazyFrame** — `crates/polars-plan/src/dsl/`: you *declare* a computation (`Expr`), Polars
  builds a logical plan, optimizes, then executes. The declaration is decoupled from execution. ↔ the
  registry: *declare* a `type_definitions` row; the generic `objects.rs` machinery executes
  CRUD/RBAC/validation from the declaration — you don't hand-write the execution per type.
- **Expression namespaces** — `crates/polars-plan/src/dsl/{string,dt,list}.rs` (`.str` / `.dt` /
  `.list`): the API surface is extended by **traits** that add methods to `Expr`, not by editing one
  giant type. ↔ per-type behavior added by a row/provider, never by growing a central `match`.

---

## Quick map

| Polars (0.54 / polars-rp) | source | RedPash analog | as-built |
|---|---|---|---|
| `ObjectRegistry` (register/get, `LazyLock<RwLock<Option<…>>>`) | `polars-core/src/chunked_array/object/registry.rs` | `type_definitions` row + generic handler; `Arc<TypeDefCache>` | shipped |
| `AnonymousObjectBuilder` (register → materialize via `&Any`) | same file | custom objects handled generically | `entity_data` path |
| `DataType::Object(name)` among typed variants | `datatypes/dtype.rs` | **Hybrid-C**: typed tables + `entity_data` | shipped |
| `AnyValue` (type-erased value) | `datatypes/any_value.rs` | `entity_data` JSONB cells; `data/src` cell matching | shipped |
| `Schema` (ordered name→dtype, runtime) | `schema/mod.rs` | `type_definitions` / `type_fields` (+ derived display fields) | shipped |
| `Expr`/LazyFrame (declare → optimize → execute) | `polars-plan/src/dsl/` | declare a type → machinery executes | shipped |
| `.str`/`.dt`/`.list` namespace traits | `polars-plan/src/dsl/{string,dt,list}.rs` | per-type behavior via row/provider | shipped |

**Bottom line**: rustc proves the pattern at compiler scale; Polars proves it **inside RedPash's own
dependency tree** (now at 0.54 via the `polars-rp` fork). The *public* parts
(`DataFrame`/`AnyValue`/`DataType`/`LazyFrame`/`Schema`) are imported today and show the
typed-plus-`Object` split that is Hybrid-C in the wild; the *internal* `ObjectRegistry` is the closest
working precedent for the registry's runtime shape — read `registry.rs` as a model (you won't import it,
you'll recognize the shape RedPash already shipped).
