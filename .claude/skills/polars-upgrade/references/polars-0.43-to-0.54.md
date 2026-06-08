# polars 0.43 → 0.54: full migration + the wasm32 fork patch

Two parts: (A) the host API recipe (mechanical, in our own `data`/`api` code), and
(B) the wasm32 fork patch (in `doumouya/polars-rp`, re-applied on each bump). Part B is
the thing that recurs and is easy to get wrong, so it's written as a re-appliable diff.

---

## A · Host API recipe (apply in `backend/crates/data` + `api`)

The dominant change is **`Series` → `Column`**: `DataFrame` is now a `Vec<Column>`, not
`Vec<Series>`. A `Column` is usually a thin wrapper over a `Series` but exposes the typed
accessors directly.

| 0.43 | 0.54 | notes |
|---|---|---|
| `df.get_columns()` → `&[Series]` | `df.columns()` → `&[Column]` | iterate `&Column` |
| `&Series` from a column | `column.as_materialized_series()` | `&Series` when you truly need Series |
| build a column from a `Series` | `series.into_column()` | `Column` |
| `col.str()/.i64()/.f64()/.bool()/.get(i)` on `Series` | same, **on `Column`** | no Series round-trip needed |
| `DataFrame::new(cols)` | `DataFrame::new_infer_height(cols)` | takes `Vec<Column>` |
| `df.with_column(Series)` | `df.with_column(Column)` | |
| `ChunkedArray` `for x in ca` | `ca.iter()` | `ChunkedArray` no longer `IntoIterator` |
| `QuantileInterpolOptions` | `QuantileMethod` | rename |
| `expr.over(...)` → `Expr` | `expr.over(...)?` → `PolarsResult<Expr>` | add `?` |
| `lf.join(other, l, r, args)` | `lf.join(other, l, r, args, None)` | trailing `Option<JoinTypeOptions>` |
| `expr.forward_fill(None)` | `expr.fill_null_with_strategy(FillNullStrategy::Forward(None))` | |
| `lit(LiteralValue::Null)` | `lit(Null {})` | |
| `df.drop(name)` / `drop_nulls(Some(&[..]))` | take a `Selector` — `cols([..])` / `by_name(names, strict, expand)` | |
| `df.rename(old, new)` | `df.rename(old, new, strict_bool)` | gained strict bool |

**Files touched in the 0.43→0.54 host pass** (for reference / next time): `data/src/`
`{clean, dedup, dtype, export, group_by, joins, parse/{filter,mod,sniff}, stats,`
`steps/{cells,columns,mod,rows,structure,util}, structure, wasm}.rs` +
`api/src/{bin/audit_distincts, routes/{demo,files/sql,group}}.rs`.

**Gotchas that bit us:**
- **`.into_iter()` vs `.iter()` over-application.** rust-analyzer flagged plain `Vec`
  iterations as "ChunkedArray" — don't blindly swap; `Vec<String>` needles stay
  `.into_iter()`. Only `ChunkedArray` lost `IntoIterator`.
- **wasm-only paths compile late.** Anything under `#[cfg(target_arch = "wasm32")]`
  (e.g. `clean.rs`'s serial dedup, `wasm.rs`'s JSON shim) is NOT compiled by the host
  pass — it surfaces only on the wasm32 check. In `wasm.rs` we hit `Vec<Series>` →
  `Vec<Column>` + `.into_column()` and `df.columns().iter().collect::<Vec<&Column>>()`
  *after* host was already green.

---

## B · The wasm32 fork patch (`doumouya/polars-rp`)

`cargo check --target wasm32-unknown-unknown -p data` fails with ~48 errors inside `mio`
(no wasm32 backend). Root cause (see runbook 0023): polars 0.54 made `polars-async` (a
tokio **multi-thread** executor + `std::thread`) an **unconditional** dep of
`polars-core`, and `polars-plan` hard-requires `polars-io/async`; the async/cloud code is
woven through the eager scan path, only *runtime*-guarded (`if run_async`), not
feature-gated. So tokio's `net` (→ mio) and `rt-multi-thread` (→ threads) are pulled
unconditionally and **no Cargo feature flag reaches it**.

**Principle:** keep the async code *compiling* (it's never reached on wasm) and remove
only the wasm-fatal *leaves*. The fix is ~110 lines across 11 files — re-apply on each bump.

### Diagnose
```
cargo tree --target wasm32-unknown-unknown -p data -i mio -e features   # invert from the leaf
cargo tree --target wasm32-unknown-unknown -p data -i tokio -e features # who enables `net`
```

### The 10 edits (re-appliable)

1. **`crates/polars/Cargo.toml`** — drop `streaming` from `csv`:
   `csv = ["polars-io", "polars-io/csv", "polars-lazy?/csv", "polars-sql?/csv"]`
   (removes the `polars-stream`/`object_store` chain on both surfaces).

2. **`crates/polars-io/Cargo.toml`** — move the unconditional `tokio` to non-wasm, give
   wasm a `sync`-only tokio (the always-compiled `stream_buf_reader` uses `tokio::sync`):
   ```toml
   [target.'cfg(not(target_family = "wasm"))'.dependencies]
   tokio = { workspace = true }
   [target.'cfg(target_family = "wasm")'.dependencies]
   tokio = { workspace = true, features = ["sync"] }
   ```

3. **`crates/polars-io/src/utils/mkdir.rs`** — `#[cfg(not(target_family = "wasm"))]` on
   `tokio_mkdir_recursive` (uses `tokio::fs`).

4. **`crates/polars-io/src/utils/byte_source.rs`** — `#[cfg(not(target_family = "wasm"))]`
   on `BufferByteSource::try_new_mmap_from_path` (tokio::fs + mmap), and split the
   `DynByteSourceBuilder::try_build_from_path` `Self::Mmap` arm: real impl off wasm, a
   `panic!` arm on wasm (keeps the match exhaustive; never reached — no path reads on wasm).

5. **`crates/polars-io/src/path_utils/mod.rs`** — `#[cfg(not(target_family = "wasm"))]` on
   `use polars_core::runtime::ASYNC;` (its only non-test user is the cloud-glob path).

6. **`crates/polars-core/Cargo.toml`** — keep `polars-async` an unconditional dep (it
   compiles on wasm via edit 8); move polars-core's own (code-unused) `tokio` off wasm:
   ```toml
   [target.'cfg(not(target_family = "wasm"))'.dependencies]
   tokio = { workspace = true, features = ["fs","net","rt-multi-thread","time","sync"] }
   ```

7. **`crates/polars-core/src/runtime.rs`** — `block_on` references `THREAD_POOL` (gated
   off wasm) → add `#[cfg(not(target_family = "wasm"))]` to the existing `block_on` and a
   wasm variant that just calls `f()` (no rayon pool on wasm).

8. **`crates/polars-async/Cargo.toml` + `src/lib.rs`** — the keystone. Target-gate tokio
   (`wasm = ["rt","sync","time"]`, no net/rt-multi-thread), and give `RuntimeManager::new`
   a wasm variant: **`Builder::new_current_thread().build()`** — a BARE runtime. **Do NOT
   add `.enable_time()`**: tokio builds the time driver eagerly and seeds it with
   `std::time::Instant::now()`, which PANICS on wasm32; `ASYNC` is a LazyLock dereffed on
   *every* collect (`dsl_to_ir/mod.rs`), so the timer crashes the engine on the first
   filter/sort/group/sql even though the runtime is "never driven" (construction touches
   the clock — this bug survived a green build, caught only by a runtime smoke). Add wasm
   variants of `block_in_place` (→ `f()`) and `block_in_place_on` (→ `self.rt.block_on(future)`).
   Result: `ASYNC` is a **real** runtime on every target, so `polars-plan`/`polars-lazy`/
   `polars-mem-engine` (which use `ASYNC.spawn` / `block_on` / typed `JoinHandle`) compile
   unchanged. *This is what stops the cascade* — a fake-stub `ASYNC` fails on typed
   `tokio::task::JoinHandle` usage; a real current-thread runtime doesn't.

9. **`crates/polars-utils/Cargo.toml` + `src/live_timer.rs`** — alias `Instant` to
   `web-time` on wasm (`#[cfg(target_family="wasm")] use web_time::Instant`; add `web-time`
   as a wasm-target dep — already in RedPash's lockfile transitively). Defensive: the
   IO-metrics `LiveTimer` isn't on the in-memory collect path, but `std::time::Instant`
   there is wasm-fatal if `IOMetrics` is ever constructed.

10. **`backend/Cargo.toml` (OUR repo, not the fork)** —
   `[patch.crates-io] polars = { git = "https://github.com/doumouya/polars-rp", rev = "<sha>" }`.
   Patch the **git** umbrella: the git workspace keeps intra-workspace `path`-deps so the
   patch cascades to every sub-crate. A *published-crate* vendor has its paths stripped —
   patching it leaves `polars-core` et al. coming from crates.io, and the patch silently
   misses (this is why the first umbrella-only-vendor attempt failed).

### Verify
```
cargo tree --target wasm32-unknown-unknown -p data -i mio          # empty
RUSTFLAGS='--cfg getrandom_backend="wasm_js"' cargo check --target wasm32-unknown-unknown -p data
cargo check --workspace && cargo test -p data                       # host unaffected
tools/build-wasm.sh                                                  # fresh frontend/wasm blob
```

Reference commit: `doumouya/polars-rp` @ `0bb178d6` (the 0.54.3 patch).
