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
