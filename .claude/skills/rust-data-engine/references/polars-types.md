# The type model — typed storage behind a type-erased handle

The single most important thing to internalize about Polars in the `data` crate: a column is a **type-erased
handle** over **concrete typed storage** (`ChunkedArray<T>`), and you move between them by downcasting. Values
cross boundaries as a type-erased **`AnyValue`**. Get this and the rest is mechanical.

> **Polars is 0.54 here** (via the doumouya/polars-rp fork; the 0.43→0.54 migration is done). The big shape
> change from 0.43 is the **`Column` ↔ `Series` split** below — a `DataFrame` is now a table of `Column`s, and
> you go `Column → as_materialized_series() → Series → .str()/.i64()/… → ChunkedArray<T>`. If you'd otherwise
> guess a polars signature, reach for the **`redpash-polars`** skill (the exact 0.54 surface this repo uses).

## DataFrame — a table of `Column`s
The materialized result of a lazy plan (`.collect()`), or built directly. Key surface used in the crate:
`.column(name) -> PolarsResult<&Column>`, **`.columns() -> &[Column]`** (this is the 0.54 name — 0.43's
`get_columns()` is gone), `.height()`/`.width()`, `.select([...])`, `.with_column(col)`, `.sort(...)`.

Construct one from owned columns with **`DataFrame::new_infer_height(vec![col0, col1, …])`** (0.54 — it infers
the height and is what the crate uses everywhere it builds a frame by hand, e.g. `clean.rs`, `parse/sniff.rs`,
`distinct.rs`, test helpers). Each element is a `Column`: build a `Series` then `.into_column()` (or `.into()`):

```rust
use polars::prelude::*;
let s = Series::new("price".into(), &[1.0_f64, 2.0, 3.0]);   // name is PlSmallStr -> "…".into()
let df = DataFrame::new_infer_height(vec![s.into_column()])?; // Series -> Column -> frame
```

Prefer building/transforming **lazily** (see `expressions.md`) and materialize once.

## `Column` — the 0.54 element of a `DataFrame`
[docs.rs](https://docs.rs/polars/latest/polars/prelude/enum.Column.html). New in the post-0.43 line: a
`DataFrame` is a `Vec<Column>`, not a `Vec<Series>`. A `Column` is usually a thin wrapper over a `Series`
(it can also be a scalar/partitioned column). Two ways the crate reads it:

```rust
for c in df.columns() {            // &[Column]
    let name = c.name();           // &PlSmallStr
    let dt   = c.dtype();          // &DataType
    let v    = c.get(i)?;          // AnyValue at row i (Column::get -> PolarsResult<AnyValue>)
    let s    = c.as_materialized_series(); // &Series — the bridge to typed downcasts
    let ca   = c.str()?;           // many typed accessors also exist straight on Column
}
```

`as_materialized_series()` is the **0.54 bridge**: when you need the `Series` typed accessors (`.str()`,
`.i64()`, …) and you're holding a `Column`, call it first (the crate does this in `clean.rs:49`,
`dtype.rs:22`). For the common string/numeric case `Column` exposes `.str()`/`.i64()`/`.get(i)` directly, so
read whichever the existing module uses.

## `Series` — the type-erased column
[docs.rs](https://docs.rs/polars/latest/polars/prelude/struct.Series.html). A `Series` is a column whose
element type is erased — internally a `dyn SeriesTrait` wrapping a concrete `ChunkedArray<T>`. Untyped surface:
`.name()`, `.dtype()`, `.len()`, `.null_count()`. To *do* anything element-wise you take the **typed view**:

```rust
let s: &Series = df.column("price")?.as_materialized_series(); // 0.54: column() -> &Column, then bridge
for v in s.f64()?.into_iter() {        // .f64() downcasts -> &Float64Chunked; None = null
    if let Some(x) = v { /* … */ }
}
let names = s2.str()?;                 // &StringChunked ; .i64() / .bool() / .datetime() likewise
```

The crate leans on `.str()` — that downcast IS the idiom; `.f64()`/`.i64()`/`.bool()` appear where a
numeric/boolean column needs element access. Build a `Series` from a name + values via
`Series::new(name.into(), values)` (the name is **`PlSmallStr`**, not `&str` — pass `"col".into()` or reuse
`series.name().clone()`; a bare `&str` is a signature mismatch), then `.into_column()` to put it in a frame or
`.into_series()`/leave it as a `Series` when you need the typed handle.

## SeriesTrait — the dyn interface a Series erases to
[docs.rs](https://docs.rs/polars/latest/polars/prelude/trait.SeriesTrait.html). The trait every column kind
implements (length, null handling, slicing, casting…). You almost never implement it; you *go through* it — a
`Series` is a boxed `dyn SeriesTrait`, and `.str()`/`.i64()`/… are the safe downcasts back to the concrete
`ChunkedArray<T>`. This is exactly the registry pattern (`rust-object-registry-design`): one erased handle,
downcast to the concrete type when you need to operate.

## ChunkedArray<T> — the concrete typed storage
[docs.rs](https://docs.rs/polars/latest/polars/prelude/struct.ChunkedArray.html). Chunked Arrow-backed storage
of one type. Iterate `into_iter() -> Option<T>` (the `Option` is the null), or `.iter()`. Typed aliases you'll
see:
[`StringChunked`](https://docs.rs/polars/latest/polars/prelude/type.StringChunked.html) (`= ChunkedArray<StringType>`),
[`UInt64Chunked`](https://docs.rs/polars/latest/polars/prelude/type.UInt64Chunked.html), `Int64Chunked`,
`Float64Chunked`, `BooleanChunked`. Build one with `.into_iter().collect()` then `.into_series()` to erase it
back, and `.into_column()` to make it a `DataFrame` element.

## AnyValue — the type-erased *value* (one cell)
The value-level twin of `Series`/`Column`: `column.get(i)? -> AnyValue`. `match` it (`AnyValue::Int64(n)`,
`AnyValue::Boolean(b)`, `AnyValue::Null`, …) — and mind that strings have **two** variants:
`AnyValue::String(&str)` (borrowed) and `AnyValue::StringOwned(PlSmallStr)` (owned, what a
`collect`/aggregation on a String column emits). A match that handles only `String` silently drops owned
strings — the crate's cell readers (`view.rs:13`, `dtype.rs`, `export.rs`) match **both**. Convert to an owned
Rust value at a boundary (the `cell`/av-to-owned helper in `view.rs`). Use `AnyValue` to move data out of the
engine without a per-type struct — it's the JSON-boundary value (see `boundary.md`). Heavy in the crate.

## DataType — the declared column type
The column's type tag (`.dtype() -> &DataType`). The variants the crate actually uses: `String`, `Date`,
`Datetime(_, _)` (note the 0.54 two-arg form `Datetime(TimeUnit, Option<TimeZone>)`), `Time`, `Boolean`,
`Int64`, `Float64`, `Null` (plus `List(_)`/`Struct(_)`). Inference lives in the `dtype` module; casting flows
through the `cast` clean op (`steps/cells.rs`). polars also defines `DataType::Object(...)` — the type-erased
escape hatch — but **this crate never uses it**; it's the cross-skill valve described in
`rust-object-registry-design`, not a pattern the data crate exercises.

## std::any — the Rust mechanism underneath
[std docs](https://doc.rust-lang.org/std/any/index.html). `Any` + `downcast_ref::<T>()` is the primitive that
makes "erased handle → concrete type" safe: Polars' `ObjectChunked<T>` stores `dyn Any` values and downcasts
on read, and the whole `Series → ChunkedArray<T>` machinery is this idea specialized. When you genuinely need
to carry an arbitrary Rust type through a typed container, `Any` is the tool — but prefer Polars' typed columns
on the hot path; reach for `Any`/`Object` only for truly open types.

## The rule of thumb

Typed access (`.str()`/`.i64()`/`ChunkedArray<T>`, via `Column::as_materialized_series()` when you start from a
`Column`) on the **hot path** (fast, no per-cell allocation); `AnyValue` and `Any`/`Object` at **boundaries**
and for **open/unknown** types. Erase to move, downcast to compute.
