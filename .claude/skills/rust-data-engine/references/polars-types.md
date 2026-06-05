# The type model — typed storage behind a type-erased handle

The single most important thing to internalize about Polars in the `data` crate: a column is a **type-erased
handle** (`Series`) over **concrete typed storage** (`ChunkedArray<T>`), and you move between them by downcasting.
Values cross boundaries as a type-erased **`AnyValue`**. Get this and the rest is mechanical.

## DataFrame — a table of Series
[docs.rs](https://docs.rs/polars/latest/polars/prelude/struct.DataFrame.html). The materialized result of a lazy
plan (`.collect()`), or built directly (the crate's `wasm::rows_to_df` builds one from JSON rows). Key surface:
`.column(name)` / `.get_columns()`, `.height()`/`.width()`, `.select([...])`, `.sort(...)`. Construct small ones
with the `df!` macro. Prefer building/transforming **lazily** (see `expressions.md`) and materialize once.

## Series — the type-erased column
[docs.rs](https://docs.rs/polars/latest/polars/prelude/struct.Series.html). A `Series` is a column whose element
type is erased — internally a `dyn SeriesTrait` wrapping a concrete `ChunkedArray<T>`. Untyped surface: `.name()`,
`.dtype()`, `.len()`, `.null_count()`. To *do* anything element-wise you take the **typed view**:

```rust
let s: &Series = df.column("price")?;   // 0.43: column() returns PolarsResult<&Series> directly
for v in s.f64()?.into_iter() {         // .f64() downcasts Series -> &Float64Chunked; None = null
    if let Some(x) = v { /* … */ }
}
let names = s2.str()?;                  // &StringChunked ; .i64() / .bool() / .datetime() likewise
```

(In polars 0.43.1 `DataFrame::column()` returns `&Series` and the typed accessors live on `Series` — there is no
`Column` type and no `.as_materialized_series()`; that Series↔Column split is a later-polars feature. Source:
`polars-core-0.43.1` `frame/mod.rs:1410`, `series/ops/downcast.rs`.)

The crate leans on `.str()` (32×) — that downcast IS the idiom; `.f64()`/`.i64()`/`.bool()` appear where a
numeric/boolean column needs element access.

## SeriesTrait — the dyn interface a Series erases to
[docs.rs](https://docs.rs/polars/latest/polars/prelude/trait.SeriesTrait.html). The trait every column kind
implements (length, null handling, slicing, casting…). You almost never implement it; you *go through* it — a
`Series` is a boxed `dyn SeriesTrait`, and `.str()`/`.i64()`/… are the safe downcasts back to the concrete
`ChunkedArray<T>`. This is exactly the registry pattern (`rust-object-registry-design`): one erased handle,
downcast to the concrete type when you need to operate.

## ChunkedArray<T> — the concrete typed storage
[docs.rs](https://docs.rs/polars/latest/polars/prelude/struct.ChunkedArray.html). Chunked Arrow-backed storage of
one type. Iterate `into_iter() -> Option<T>` (the `Option` is the null). Typed aliases you'll see:
[`StringChunked`](https://docs.rs/polars/latest/polars/prelude/type.StringChunked.html) (`= ChunkedArray<StringType>`),
[`UInt64Chunked`](https://docs.rs/polars/latest/polars/prelude/type.UInt64Chunked.html), `Int64Chunked`,
`Float64Chunked`, `BooleanChunked`. Build one with `.into_iter().collect()` then `.into_series()` to erase it back.
(Naming note: `Series::new` (via `NamedFrom`) takes the name as `PlSmallStr`, not `&str` — pass `"col".into()` or
reuse `series.name().clone()`, the crate's pattern; a bare `&str` is a 0.43 signature mismatch.)

## AnyValue — the type-erased *value* (one cell)
The value-level twin of `Series`: `series.get(i)? -> AnyValue`. `match` it (`AnyValue::Int64(n)`,
`AnyValue::Null`, …) — and mind that strings have **two** variants: `AnyValue::String(&str)` (borrowed) and
`AnyValue::StringOwned(PlSmallStr)` (owned, what a `collect`/aggregation on a String column emits). A match that
handles only `String` silently drops owned strings — the crate's `av_to_owned`-style code matches both
(`AnyValue::StringOwned` is used 15× in `src`). Convert to an owned Rust value at a boundary (the `av_to_owned`
helper, e.g. `routes/group.rs:189`). Use `AnyValue` to move data out of the engine without a per-type struct —
it's the JSON-boundary value (see `boundary.md`). Heavy in the crate (~72×).

## DataType — the declared column type
The column's type tag. The variants the crate actually uses: `String`, `Date`, `Datetime`, `Time`, `Boolean`,
`Int64`, `Float64`, `Null` (plus `List(_)`/`Struct(_)`). Inference lives in the `dtype` module. polars 0.43 also
defines `DataType::Object(&'static str, Option<Arc<ObjectRegistry>>)` (a 2-tuple, not `Object(name)`) — the
type-erased escape hatch — but **this crate never uses it** (`DataType::Object` = 0× in `src`); it's the
cross-skill Hybrid-C valve described in `rust-object-registry-design`, not a pattern the data crate exercises.
`DataType` ~62× in the crate.

## std::any — the Rust mechanism underneath
[std docs](https://doc.rust-lang.org/std/any/index.html). `Any` + `downcast_ref::<T>()` is the primitive that
makes "erased handle → concrete type" safe: Polars' `ObjectChunked<T>` stores `dyn Any` values and downcasts on
read, and the whole `Series → ChunkedArray<T>` machinery is this idea specialized. When you genuinely need to
carry an arbitrary Rust type through a typed container, `Any` is the tool — but prefer Polars' typed columns on
the hot path; reach for `Any`/`Object` only for truly open types.

## The rule of thumb

Typed access (`.str()`/`.i64()`/`ChunkedArray<T>`) on the **hot path** (fast, no per-cell allocation); `AnyValue`
and `Any`/`Object` at **boundaries** and for **open/unknown** types. Erase to move, downcast to compute.
