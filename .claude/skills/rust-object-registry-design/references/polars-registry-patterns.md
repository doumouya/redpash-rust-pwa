# Polars → RedPash: the in-dependency registry exemplar

rustc (`references/rustc-registry-patterns.md`) is the type-*system* model; **Polars is the data model**, and
it's sharper here for two reasons: (1) RedPash's `data` crate already runs on Polars, so these patterns are
*importable*, not just instructive; (2) Polars solves the exact custom-object problem — "register a type the
engine didn't know at compile time, store it type-erased, handle it generically" — and ships a literal
**object registry** for it. Pointers are into the `polars-rp-main.zip` snapshot (Polars main).

---

## 1 · The headline — Polars' runtime `ObjectRegistry`

**Polars** — `crates/polars-core/src/chunked_array/object/registry.rs`. The module's own opening line:
*"a heap allocated utility that can be used to register an object type. That object type will know its own
generic type parameter `T` and callers can simply send `&Any` values and don't have to know the generic type
themselves."*

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

**RedPash analog** — this is `register_type` → the generic handler, almost line for line:
- `ObjectRegistry` (a struct of provider fn-pointers) ↔ a registered TypeDefinition's providers (storage, field
  set, RBAC defaults). rustc's `Providers` is the compiler twin; Polars shows it for *data objects*.
- `register_object_builder()` / `get_object_builder(name, …)` ↔ `register_type` / look-up-by-`type_id` then act.
- `AnonymousObjectBuilder` registered → materialize via `&Any` ↔ custom objects handled generically without the
  handler knowing the concrete type (our `entity_data` JSONB rows).

**Lesson** — the shape we need is *proven inside our own dependency*: a global `LazyLock<RwLock<Option<…>>>` of
provider functions, `register_*` to install, `get_*(name)` to dispatch. Note it independently lands on
**`RwLock<Option<…>>`** — the exact shape flagged for `TypeDefCache` (and confirms the read-mostly/write-on-register
access pattern). Model `register_type` on this, not on a bespoke design.

---

## 2 · The typed-vs-erased split — `DataType::Object` validates Hybrid-C

**Polars** — `crates/polars-core/src/datatypes/dtype.rs:90`:

```rust
pub enum DataType {
    Boolean, Int64, /* … */ String,        // typed, known-at-compile-time variants
    List(Box<DataType>),
    Struct(Vec<Field>),
    Object(&'static str),                   // line 132 — the type-erased escape hatch (carries a type NAME)
    Null, Categorical(…), /* … */
}
```

Polars keeps **fast typed variants for known shapes** and **one `Object(name)` escape hatch** for types the
engine didn't bake in — exactly the **Hybrid-C** storage decision: builtins keep their typed tables; custom
types live as a named, type-erased `entity_data` row. Polars proves you don't choose between "all typed" and
"all dynamic" — you keep typed for the hot known set and add one open variant. (`Object` even carries a
`&'static str` name — the same interning lesson from rustc: the type label is an interned handle.)

**RedPash analog** — `DataType::Object(name)` ↔ `entity_data(type_id, … data JSONB)` alongside the typed
`companies`/`projects`/… tables. The 7 builtins stay typed; custom types are `Object`-equivalent.

---

## 3 · Type-erased values + dynamic schema

- **`AnyValue`** — `crates/polars-core/src/datatypes/any_value.rs:34` (`pub enum AnyValue<'a>`): a type-erased,
  borrow-or-owned dynamic value used to move data across the typed/untyped boundary. ↔ the JSONB cell values in
  `entity_data` — one value type that can hold any field's data without a per-type Rust struct.
- **`Schema`** — `crates/polars-core/src/schema/mod.rs:12`: `pub type Schema = polars_schema::Schema<DataType, ()>`
  (an *ordered* name→dtype map; `SchemaRef = Arc<Schema>`). A schema is data — built/extended at runtime, not a
  compile-time struct. ↔ `type_definitions` + `type_fields`: a type's field set is rows, queried at runtime.

---

## 4 · Declarative plan + extensible API surface

- **`Expr` / LazyFrame** — `crates/polars-plan/src/dsl/`: you *declare* a computation (`Expr`), Polars builds a
  logical plan, optimizes, then executes. The declaration is decoupled from execution. ↔ the registry goal:
  *declare* a TypeDefinition; the generic machinery executes CRUD/RBAC/validation from the declaration — you
  don't hand-write the execution per type.
- **Expression namespaces** — `crates/polars-plan/src/dsl/{string,dt,list}.rs` (`.str` / `.dt` / `.list`): the API
  surface is extended by **traits** that add methods to `Expr`, not by editing one giant type. ↔ per-type
  behavior added by implementing a trait/provider, never by growing a central `match`.

---

## Quick map

| Polars | source (polars-rp-main/) | RedPash analog | stage |
|---|---|---|---|
| `ObjectRegistry` (register/get, `LazyLock<RwLock<Option<…>>>`) | `crates/polars-core/src/chunked_array/object/registry.rs` | `register_type` → generic handler; `Arc<RwLock<TypeDefCache>>` | 2–3 |
| `AnonymousObjectBuilder` trait (register → materialize via `&Any`) | same file | custom objects handled generically | 3 |
| `DataType::Object(name)` among typed variants | `datatypes/dtype.rs:132` | **Hybrid-C**: typed tables + `entity_data` | 3 |
| `AnyValue` (type-erased value) | `datatypes/any_value.rs:34` | `entity_data` JSONB cells | 3 |
| `Schema` (ordered name→dtype, runtime) | `schema/mod.rs:12` | `type_definitions` / `type_fields` | 1 |
| `Expr`/LazyFrame (declare → optimize → execute) | `polars-plan/src/dsl/` | declare a type → machinery executes | 2–3 |
| `.str`/`.dt`/`.list` namespace traits | `polars-plan/src/dsl/{string,dt,list}.rs` | per-type behavior via trait/provider | 2–3 |

**Bottom line**: rustc proves the pattern at compiler scale; **Polars proves it inside a crate RedPash already
links**, with a named `ObjectRegistry` and a typed-plus-`Object` dtype split that is Hybrid-C in the wild. When
designing `register_type` and the storage split, read `registry.rs` first — it is the closest working precedent.
