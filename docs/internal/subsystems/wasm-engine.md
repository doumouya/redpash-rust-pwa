---
title: WASM engine
section: Internal
order: 28
last modified date: 2026-05-24
owner: Gus
status: filled
---

# WASM engine

The `data` crate compiles to a browser-loadable WASM module that
the frontend lazy-loads to run the same engine in-browser that
runs on the server. Used today by the landing-page CSV demo
(`upload → parse → auto_clean → render summary`, all client-side,
file never leaves the browser); designed to back the workspace
preview path too (filter/sort/clean a loaded page locally, no
round-trip).

**One engine, two surfaces, gated by capacity not capability** —
the landing demo and the workspace use the same `.wasm`, the only
difference is the 5 MB upload cap on the demo path.

Phasing + design rationale: [architecture/roadmap-webassembly](../architecture/roadmap-webassembly.md).
This doc is the operational reality after Phases 0/A/B/B-1 landed.

Source of truth: `backend/crates/data/src/wasm.rs`,
`backend/crates/data/Cargo.toml` (target-split deps),
`tools/build-wasm.sh`, `frontend/scripts/wasm-engine.js`,
`frontend/wasm/README.md`.

## What makes the `data` crate portable

The crate was structurally WASM-ready before WASM was on the
roadmap. The JS/Rust boundary discipline ([architecture/js-rust-boundary](../architecture/js-rust-boundary.md))
bought it for free:

```
grep -rn 'std::fs::|::open|::read_to_string|tokio::fs' src/  → 0 hits
grep -rn 'std::thread|tokio::|rayon|par_iter'           src/  → 0 hits
```

Every byte enters as a buffer the caller supplies; every result
exits as a `DataFrame` / `String` / serializable struct. No IO, no
async, no threading. That's the precondition for WASM; everything
else is dependency-juggling.

## Four transitive-dep gotchas (Phase 0/A)

The data crate compiles for `wasm32-unknown-unknown` only after
four upstream issues are addressed via target-split Cargo features:

```toml
# backend/crates/data/Cargo.toml

[target.'cfg(not(target_arch = "wasm32"))'.dependencies]
polars         = { workspace = true }            # ← server: defaults on (fmt)
pulldown-cmark = { workspace = true }            # ← server-only: render.rs
syntect        = { workspace = true }            # ← server-only: render.rs
gray_matter    = { workspace = true }
maud           = { workspace = true }

[target.'cfg(target_arch = "wasm32")'.dependencies]
polars                    = { version = "0.43", default-features = false,
                              features = ["lazy", "csv", "strings",
                                          "dtype-full", "regex", "concat_str"] }
uuid                      = { version = "1", features = ["v4", "serde", "js"] }
getrandom                 = { version = "0.3", features = ["wasm_js"] }
wasm-bindgen              = "0.2"
console_error_panic_hook  = "0.1"
```

The four:

1. **Polars's default `fmt` feature** pulls `comfy-table` →
   `crossterm` (terminal IO). Doesn't compile on wasm32. Fix:
   `default-features = false` on the wasm32 polars dep; six
   explicit features replace what's actually used. Server keeps
   defaults (the `fmt` feature is what gives `DataFrame: Debug` its
   pretty-print in tracing).

2. **Doc-render deps** (`pulldown-cmark`, `syntect`, `gray_matter`,
   `maud`) — `syntect → onig_sys` needs `clang` to build a C regex
   engine; `syntect → crossterm` same problem. All four are
   server-only (they back `data::render` for `/api/docs` + Maud
   templates). Gated to non-wasm targets, and `pub mod render` in
   `lib.rs` is `#[cfg(not(target_arch = "wasm32"))]`-gated to
   match.

3. **`uuid` needs the `js` feature** for wasm32 RNG. Pulled
   directly with `v4 + serde + js` on the wasm32 target only.

4. **`getrandom` 0.3.x** compiles for wasm32 only with **both** the
   `wasm_js` feature (dep-level) AND the `--cfg
   getrandom_backend="wasm_js"` rustc flag (build-time via
   `RUSTFLAGS`). Pulled directly so Cargo's feature unification
   flips it on for every transitive consumer (polars / rayon-core
   / ahash).

5. **`console_error_panic_hook`** isn't a compile blocker but
   is debugging hygiene — without it, every Rust panic on wasm32
   surfaces as a bare `RuntimeError: unreachable executed` with no
   file / line / payload. Installed at module init via
   `#[wasm_bindgen(start)]`. See "the rayon trap" below.

## The four wrappers (Phase B)

`backend/crates/data/src/wasm.rs` defines `#[wasm_bindgen]` entry
points. JSON in, JSON out — no Polars types cross the wasm
boundary:

```js
import { getEngine } from "/scripts/wasm-engine.js";
const engine = await getEngine();

engine.apply_filter(rows_json, params_json)  // → rows_json
engine.apply_sort  (rows_json, by, descending)  // → rows_json
engine.auto_clean  (rows_json)               // → { rows, summary }
engine.step_preview(rows_json, kind, params_json)  // → rows_json
```

`step_preview` dispatches the full 17-kind [step engine](step-engine.md)
palette — the browser gets every server-side cleaning op without a
per-kind wrapper.

Each wrapper:

1. Parses `rows_json` to a `serde_json::Value` array.
2. Walks the rows into a `polars::DataFrame` via
   `rows_to_df(rows_json)` — per-column type inference from the
   first non-null value (number / bool / string). Sufficient for
   the page-preview use case where rows came from a typed source
   (the server's `/api/files/:rid/page` response).
3. Calls the engine function the server calls (`clean::auto_clean`,
   `steps::apply`, …).
4. Walks the result back to JSON via `df_to_rows(df)`.
5. Returns the JSON string.

The wrappers *don't reimplement* anything — they're a marshaling
layer over the same code the server runs. That's what makes the
size measurement honest: the wasm binary's content == the server
engine's content.

## The rayon trap — serial dedup

Polars' `unique_stable(...)` (used by `clean::auto_clean`'s
duplicate-row drop) routes through `df._apply_columns_par(...)` →
rayon's `POOL.install(...)`. On `wasm32-unknown-unknown` without
SharedArrayBuffer + COEP/CORP headers, rayon's POOL initialization
**traps** — the panic surfaces as a bare `unreachable executed`.

Fix (`42fb49d`): `data::clean::auto_clean` cfg-splits the dedup
call. Server keeps `unique_stable` (fast on big frames). Wasm uses
`drop_dupe_rows_serial(df)` — walks rows once with a
`HashSet<Vec<String>>` of `{:?}`-formatted cell signatures, then
rebuilds each Series by walking kept indices per its concrete
dtype (String / Bool / Float64 / Int64) to sidestep Polars'
`filter` / `take` / `take_iter` (which also route through
par_iter).

The same trap is latent in any other Polars op that calls
`_apply_columns_par`. If a new wasm wrapper hits a new panic,
`console_error_panic_hook` now surfaces the call site — apply the
same cfg-split pattern.

## Build pipeline — `tools/build-wasm.sh`

Three stages:

```
1. cargo build --release --target wasm32-unknown-unknown -p data
     RUSTFLAGS='--cfg getrandom_backend="wasm_js"'

2. wasm-bindgen --target web --out-dir frontend/wasm --out-name data
     <release .wasm>
   → emits:
     frontend/wasm/data.js               (~18 KB — the JS glue)
     frontend/wasm/data_bg.wasm          (~16 MB — the imports-bound .wasm)
     frontend/wasm/data.d.ts             (TypeScript types)
     frontend/wasm/data_bg.wasm.d.ts

3. wasm-opt -Oz --strip-debug
     --enable-{reference-types,bulk-memory,mutable-globals,
              nontrapping-float-to-int,sign-ext,simd,multivalue,
              tail-call,extended-const,gc}
     -o frontend/wasm/data_bg.opt.wasm frontend/wasm/data_bg.wasm
   → optimized .wasm replaces the pre-opt version in place.
```

End-to-end measurement (current state):

```
data_bg.wasm         ~11.5 MB raw   ~3.27 MB gz
data.js               ~18 KB raw    ~4 KB   gz
TOTAL OVER-THE-WIRE                 ~3.28 MB gz
```

Polars is ~67% of the dep weight; cutting that further requires
relaxing the polars feature set, which trades engine completeness
for bundle size — a Phase C decision tied to which surface needs
the engine.

Prerequisites (one-shot per machine):

```
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.121
cargo install wasm-opt
```

## Why the binary isn't in git

`.gitignore` excludes `frontend/wasm/data_bg.wasm`,
`frontend/wasm/data.js`, `frontend/wasm/*.d.ts`. The Rust source is
the source of truth; the binary regenerates on demand via
`sh tools/build-wasm.sh`. Committing 11 MB of compiled output would
bloat git history forever for what's a one-command rebuild.

`frontend/wasm/README.md` is committed — it's the human-facing
contract page authors read.

## Frontend integration

`frontend/scripts/wasm-engine.js` is the loader. Two exports:

- **`getEngine()`** — memoised lazy loader. First await fetches +
  stream-compiles `/wasm/data.js` + `/wasm/data_bg.wasm`. The
  browser stream-compiles the .wasm during download, so engine ops
  become callable before the full bytes arrive. Subsequent awaits
  are instant.
- **`gateBySize(file)`** — throws `RangeError` if
  `file.size > DEMO_CAP_BYTES` (5 MB). UI-agnostic; the caller
  renders the rejection (sign-up CTA, toast, …) however the page
  wants.

Two load patterns per surface:

| Surface | Pattern |
|---|---|
| Landing demo | **Lazy** — `getEngine()` awaited only after `gateBySize(file)` passes. Cold visitors pay 0 bytes. Visitors with a >5 MB file get the sign-up CTA without downloading the engine. |
| Workspace | **Preload** — `getEngine()` fired on workspace mount, no await. By the time the user touches the filter UI, the engine is warm. |

The 5 MB cap is the conversion lever — bigger files need an
account. That CTA is honest because the account *does* unlock
something different (persistence, multi-step cleaning, no demo
cap).

## File-never-leaves-browser privacy

A subtle property of the lazy-load + in-browser-parse model: the
landing demo's CSV file never crosses the wire. The page reads
`file.text()` locally, parses with the wasm engine, renders the
summary — no upload, no server visibility into the file's contents.

This is a real differentiator vs competitors who upload-to-server-
to-parse. Worth keeping in the messaging.

## Adding a new wasm wrapper

1. Add the `#[wasm_bindgen]` function to `data::wasm`. JSON in,
   JSON out (use `&str` for inputs, `Result<String, JsValue>` for
   the return). Call into the engine's existing functions.
2. If the engine function uses Polars par_iter under the hood
   (`unique_stable`, `filter`, `take` family), expect a runtime
   trap on wasm32 — cfg-split the engine path the same way
   `clean::auto_clean` does for `unique_stable`.
3. `sh tools/build-wasm.sh` regenerates the bundle. The new
   wrapper appears on the `engine` object returned by
   `getEngine()` automatically (the wasm-bindgen `--target web`
   output exports everything `#[wasm_bindgen]`'s).
4. No frontend change needed for the loader — `wasm-engine.js`
   passes through whatever the bundle exports. Add a usage
   example to `frontend/wasm/README.md`.
5. Test in a real browser. `cargo check --target wasm32...` only
   catches compile failures; runtime traps (the rayon class) need
   an actual invocation.

## Cross-cuts

- **Same engine, two runtimes.** When the engine grows a new op,
  it's wasm-callable for free via `step_preview` if it's a step
  kind; explicit wrapper otherwise. The boundary contract holds:
  Rust owns data, JS owns pixels.
- **Threading is the next cliff.** Polars on threaded wasm (with
  SharedArrayBuffer + `wasm-bindgen-rayon`) is faster but needs
  COEP/CORP headers in the server response — a deploy-config
  change, not a code change. Phase C territory per the roadmap.
- **The audit chain knows the wasm path.** `rs-audit` reports
  `wasm32 build status: ok / N MB stripped`; `crossing-audit` will
  eventually add a "runtime axis" view (which Rust functions are
  reachable from which runtime). Both fit the
  [cleaning-cadence](../processes/audit-cadence.md) rule — wasm-
  readiness becomes a tracked metric, not a hope.

## Rust internals — wrapper bodies + serial dedup

### `rows_to_df` — JSON → DataFrame with type inference

```rust
fn rows_to_df(rows_json: &str) -> Result<DataFrame, String> {
    let rows: Vec<serde_json::Map<String, Value>> = serde_json::from_str(rows_json)?;
    if rows.is_empty() { return Ok(DataFrame::empty()); }
    let columns: Vec<String> = rows[0].keys().cloned().collect();

    let mut series_list: Vec<Series> = Vec::with_capacity(columns.len());
    for col in &columns {
        // Type inference from FIRST non-null value across all rows.
        let kind: &str = rows.iter().find_map(|r| match r.get(col) {
            Some(Value::Number(_)) => Some("number"),
            Some(Value::Bool(_))   => Some("bool"),
            Some(Value::String(_)) => Some("string"),
            _                      => None,
        }).unwrap_or("string");

        let s = match kind {
            "number" => {
                let v: Vec<Option<f64>> = rows.iter().map(|r| {
                    r.get(col).and_then(|v| v.as_f64().or_else(|| v.as_i64().map(|n| n as f64)))
                }).collect();
                Series::new(col.as_str().into(), v)
            }
            "bool" => {
                let v: Vec<Option<bool>> = rows.iter()
                    .map(|r| r.get(col).and_then(|v| v.as_bool())).collect();
                Series::new(col.as_str().into(), v)
            }
            _ => {
                let v: Vec<Option<String>> = rows.iter().map(|r| {
                    r.get(col).and_then(|v| match v {
                        Value::Null      => None,
                        Value::String(s) => Some(s.clone()),
                        other            => Some(other.to_string()),
                    })
                }).collect();
                Series::new(col.as_str().into(), v)
            }
        };
        series_list.push(s);
    }
    DataFrame::new(series_list).map_err(|e| format!("df build: {e}"))
}
```

**Inference policy**: first non-null per column wins. Mixed types
in one column get coerced to the inferred dtype's representation
(e.g. boolean cells in a number column become NULL, since
`as_f64()` returns None for booleans). That's the same behavior
Polars' own JSON reader uses; we replicate it manually to avoid
adding the `polars-json` feature (which pulls more deps and grows
the wasm bundle).

**Allocations**:
- One `Vec` per column (typed) sized to `rows.len()`.
- `Vec<Option<String>>` for string columns clones each input
  string. Could be `Cow<str>` if zero-copy mattered, but for the
  5 MB-cap demo path the clone overhead is ~10ms on typical files
  — negligible against the parse + auto_clean costs.

**Column-order stability**: takes `keys()` from `rows[0]`. Object
key insertion order in JSON is preserved by serde_json, so the
order matches the input JSON's order. The wrappers' output via
`df_to_rows` preserves the same order.

### `df_to_rows` — DataFrame → JSON

```rust
fn df_to_rows(df: &DataFrame) -> Result<String, String> {
    let n = df.height();
    let cols: Vec<&Series> = df.get_columns().iter().collect();
    let mut rows: Vec<Value> = Vec::with_capacity(n);
    for i in 0..n {
        let mut row = serde_json::Map::with_capacity(cols.len());
        for c in &cols {
            let v: Value = match c.get(i).unwrap_or(AnyValue::Null) {
                AnyValue::Null            => Value::Null,
                AnyValue::Boolean(b)      => Value::Bool(b),
                AnyValue::Int8(n) | AnyValue::Int16(n) | AnyValue::Int32(n) | ... => json!(n),
                AnyValue::Float32(n) | AnyValue::Float64(n) => json!(n),
                AnyValue::String(s)       => Value::String(s.into()),
                AnyValue::StringOwned(s)  => Value::String(s.to_string()),
                other                     => Value::String(other.to_string()),
            };
            row.insert(c.name().to_string(), v);
        }
        rows.push(Value::Object(row));
    }
    serde_json::to_string(&rows).map_err(|e| format!("rows serialize: {e}"))
}
```

**Per-row, per-cell allocation**: each AnyValue match branch
allocates per cell. Polars stores columns as chunked arrays;
walking with `c.get(i)` is O(log chunks) per access. For typical
page sizes (25-100 rows), totally fine; for the upper bound (5 MB
file ≈ tens of thousands of rows), this becomes the dominant
cost. Optimization horizon: batch per-column with iterators
(`c.str()?.into_iter()`, `c.f64()?.into_iter()`, etc.) and skip
the AnyValue layer.

### `drop_dupe_rows_serial` — the wasm-only dedup

```rust
#[cfg(target_arch = "wasm32")]
fn drop_dupe_rows_serial(df: DataFrame) -> Result<DataFrame> {
    use std::collections::HashSet;
    let height = df.height();
    if height < 2 { return Ok(df); }

    let mut seen: HashSet<Vec<String>> = HashSet::with_capacity(height);
    let mut keep_mask: Vec<bool> = Vec::with_capacity(height);
    let cols = df.get_columns();
    for i in 0..height {
        let sig: Vec<String> = cols.iter()
            .map(|c| format!("{:?}", c.get(i).unwrap_or(AnyValue::Null)))
            .collect();
        keep_mask.push(seen.insert(sig));
    }
    if keep_mask.iter().all(|&k| k) { return Ok(df); }  // no dupes — return as-is

    // Per-dtype Series rebuild (avoids Polars' filter/take which also par_iter)
    let new_cols: Vec<Series> = cols.iter().map(|col| -> Result<Series> {
        let name = col.name().clone();
        match col.dtype() {
            DataType::String => {
                let ca = col.str()?;
                let v: Vec<Option<&str>> = (0..height)
                    .filter(|&i| keep_mask[i]).map(|i| ca.get(i)).collect();
                Ok(Series::new(name, v))
            }
            DataType::Boolean => { /* same shape, bool typed */ }
            DataType::Float64 => { /* same shape, f64 typed */ }
            DataType::Int64   => { /* same shape, i64 typed */ }
            _ => {
                // Fallback via AnyValue rebuild — shouldn't trigger
                // for auto_clean's output (which only produces these
                // four dtypes) but defended.
                let values: Vec<AnyValue> = (0..height)
                    .filter(|&i| keep_mask[i])
                    .map(|i| col.get(i).unwrap_or(AnyValue::Null))
                    .collect();
                Series::from_any_values_and_dtype(name, &values, col.dtype(), false)
                    .map_err(DataError::from)
            }
        }
    }).collect::<Result<Vec<_>>>()?;

    DataFrame::new(new_cols).map_err(DataError::from)
}
```

**Why `Vec<String>` for the signature key**: HashSet on
`Vec<String>` hashes the vector's elements in order, so two rows
with the same cells (in column order) hash identically. The
alternative — `Vec<AnyValue>` — doesn't implement `Hash` directly,
and going through `{:?}` is uniform across dtype.

**Performance**: O(rows × col_count) for signature build +
O(rows × col_count) for typed rebuild. For 1k rows × 20 cols ≈
40k operations — runs in tens of milliseconds. The serial
implementation is slower than par on large frames but linear,
predictable, and runtime-portable.

**Why per-dtype rebuild instead of `Series::from_any_values`**:
the typed path is ~3x faster on large frames (no per-cell
AnyValue boxing). The fallback exists for defensive correctness;
auto_clean's output dtype set never triggers it today.

## Build pipeline — `tools/build-wasm.sh` line by line

```sh
#!/usr/bin/env sh
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/backend"

# Stage 1 — cargo build (release, wasm32)
RUSTFLAGS='--cfg getrandom_backend="wasm_js"' \
  cargo build --release --target wasm32-unknown-unknown -p data
cd "$REPO_ROOT"

# Stage 2 — wasm-bindgen → frontend/wasm/
mkdir -p frontend/wasm
wasm-bindgen --target web --out-dir frontend/wasm --out-name data \
  backend/target/wasm32-unknown-unknown/release/data.wasm

# Stage 3 — wasm-opt -Oz strip
wasm-opt -Oz --strip-debug \
  --enable-reference-types --enable-bulk-memory --enable-mutable-globals \
  --enable-nontrapping-float-to-int --enable-sign-ext --enable-simd \
  --enable-multivalue --enable-tail-call --enable-extended-const --enable-gc \
  -o frontend/wasm/data_bg.opt.wasm frontend/wasm/data_bg.wasm
mv frontend/wasm/data_bg.opt.wasm frontend/wasm/data_bg.wasm
```

**Why `--target web`** to wasm-bindgen: emits an ES module with
`async init()` default export — the right shape for the
frontend's dynamic `import('/wasm/data.js')` pattern. Other
targets (`nodejs`, `no-modules`) emit different glue and don't
match our loader.

**Why every `--enable-<feature>` flag**: `wasm-opt`'s validator
rejects features it doesn't know about. Modern Rust + LLVM emit
wasm using reference-types, bulk-memory, mutable-globals,
nontrapping-float-to-int, sign-ext, simd, multivalue, tail-call,
extended-const, gc — all standardized in different wasm proposal
phases. Without the flags wasm-opt would error out at validate
time even though the output is well-formed.

**Why `-Oz`** (size-optimize) vs `-O3` (speed-optimize): size
matters more than runtime perf for a 3 MB bundle delivered over
network. The size savings: ~5 MB raw → ~11 MB raw after
wasm-bindgen (which adds glue exports) → ~11.5 MB unoptimized
release → 11.5 MB optimized release? Actually wasm-opt cuts about
4 MB off the raw via dead-code-elimination + function inlining;
the gzip savings are smaller because much of the bundle is
already entropy-rich.

## Frontend internals — `wasm-engine.js`

### Lazy loader memoization

```js
let _enginePromise = null;

export async function getEngine() {
  if (_enginePromise) return _enginePromise;
  _enginePromise = (async () => {
    const mod = await import('/wasm/data.js');
    await mod.default(); // wasm-bindgen init — fetches + instantiates data_bg.wasm
    return {
      apply_filter:  mod.apply_filter,
      apply_sort:    mod.apply_sort,
      auto_clean:    mod.auto_clean,
      step_preview:  mod.step_preview,
    };
  })();
  return _enginePromise;
}
```

**Why store the *promise* and not the resolved engine**: avoids
the second-caller race where two concurrent `getEngine()` calls
both start a download. Storing the promise means callers 2+
await the same in-flight init.

**Why `import('/wasm/data.js')` dynamic**: ES modules are cached
by URL — first call kicks the fetch, subsequent calls hit the
module map cache. Streaming compile happens during the fetch;
`mod.default()` resolves once the .wasm is instantiated.

### `gateBySize` — the 5 MB cap

```js
export const DEMO_CAP_BYTES = 5 * 1024 * 1024;

export function gateBySize(file) {
  if (file.size > DEMO_CAP_BYTES) {
    const limitMb = (DEMO_CAP_BYTES / 1024 / 1024).toFixed(0);
    const sizeMb  = (file.size      / 1024 / 1024).toFixed(2);
    throw new RangeError(
      `file is ${sizeMb} MB; demo limit is ${limitMb} MB. ` +
      `Sign up for a free account to handle any size.`
    );
  }
  return file;
}
```

**Synchronous + throws** because the cap-gate decision is "do I
bother awaiting `getEngine()`?". A 6 MB file should never trigger
the 3 MB download; throwing here is what saves the bandwidth.

The error message is UI-bound — the caller catches and renders
the sign-up CTA. UI-agnostic helper (`gateBySize` doesn't know
about the DOM).

## Optimization map — current binary surface

| Layer | Size | Optimization horizon |
|---|---|---|
| Raw .wasm (wasm-bindgen output) | ~16 MB | Comes from polars + serde + chrono + the rest of the data crate |
| `-Oz --strip-debug` | ~11.5 MB | Saves ~4.5 MB via DCE + symbol-name strip |
| Gzipped (over-the-wire) | ~3.3 MB | The number that matters |
| JS glue (`data.js`) | ~18 KB raw / ~4 KB gz | Stable; small |
| Type definitions (`*.d.ts`) | ~3 KB | Not delivered to runtime |

**Cutting the 3.3 MB further** would require trimming polars
features (drop `regex`, `concat_str`, parts of `dtype-full` —
loses engine capabilities) or replacing polars with a hand-rolled
mini-engine for the demo path only (breaks "one engine, two
surfaces"). Both have real product cost; neither is on today's
roadmap.

**Threading-aware build** (Phase C territory): `RUSTFLAGS='--cfg
getrandom_backend="wasm_js" -C target-feature=+atomics,+bulk-memory'`
+ `wasm-bindgen-rayon` + deploy COEP/CORP headers. Polars parse
+ filter would multi-thread on supported browsers (Chrome with
the headers). Cost: an extra build profile, slightly larger
binary (~5% from atomics), and the deploy config. Payoff:
parse/sort throughput catches up with the server version on
big files.
