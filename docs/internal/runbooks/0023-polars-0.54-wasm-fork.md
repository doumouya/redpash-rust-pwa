# 0023 — polars 0.54 would not compile for `wasm32-unknown-unknown` (tokio→mio)

The polars 0.43 → 0.54 migration broke the **browser** half of "one engine, two
surfaces": polars 0.54 made an unconditional tokio dependency (→ `mio`) reach
`polars-core`, and `mio` has no `wasm32-unknown-unknown` backend. The fix — a thin
`doumouya/polars-rp` fork consumed via `[patch.crates-io]` — is **live on lean** today
([`backend/Cargo.toml`](../../../backend/Cargo.toml)). This doc is the historical
reasoning record (the WHY) plus the upgrade playbook; it was restored on lean — it had
lived under `docs/internal/runbooks/` on `prerelease` and was dropped in the graduation.

## Problem statement

The Polars 0.43 → 0.54 migration shipped clean for the **server** (commit `690e2da`:
whole-workspace `cargo check` clean, the `data` tests pass), but
`cargo check --target wasm32-unknown-unknown -p data` failed with ~48 errors, **all
inside the `mio` crate** — which has no `wasm32-unknown-unknown` backend. Without a wasm
build the pure-compute `data` engine can't run in the browser, so the client-side compute
surface (workspace client-sort, the investor-POC 101k-rows-in-2.2s path, "bytes never
leave the device") was dead on 0.54.

## How the dependency was traced

1. **Invert the dep graph from the leaf** — don't read errors top-down:
   `cargo tree --target wasm32-unknown-unknown -p data -i mio -e features`. `mio`'s only
   parent is `tokio`; `tokio`'s only parent (after step 2) is `polars-io`.
2. **First cut — `polars-io`'s tokio.** `polars-io` declared `tokio` **unconditionally**,
   even though every tokio-*using* module in it (`pl_async`, `cloud`, `file_cache`) is
   feature-gated behind `async`/`cloud`/`file_cache` — none of which RedPash enables.
   Gating that dep off wasm moved `mio` one level up.
3. **Whack-a-mole revealed the real shape.** `mio` reappeared via `polars-plan`; the
   `net` feature traced to **two** unconditional enablers: `polars-core`
   (`tokio[fs,net,rt-multi-thread,…]`, *unused in polars-core's own code*) and
   `polars-async` (`tokio[net,rt-multi-thread,…]`, the actual async executor).
   Cargo feature-unification turns `net` on for the whole shared `tokio`, so `mio`
   compiles for everyone.
4. **The async machinery is woven through the plan/scan layer.** `polars-plan` *requires*
   `polars-io/async` (hard dep), and `polars-plan`/`polars-lazy`/`polars-mem-engine`
   reference `polars_core::runtime::ASYNC` and `polars_io::utils::byte_source` from code
   that is only *runtime*-guarded by `if run_async` (cloud / `force_async`, both false on
   wasm) — **not** feature-gated. So you cannot simply turn `async` off; the unconditional
   references would dangle.

## Root cause

polars 0.54's new async/cloud/streaming engine made the async runtime (`polars-async`, a
tokio **multi-thread** executor + `std::thread`) an **unconditional** dependency of
`polars-core`, and wove `ASYNC` / async byte-sources through the eager DSL→IR scan path.
On `wasm32-unknown-unknown` there are no OS threads and no socket layer, so tokio's `net`
(→ `mio`) and `rt-multi-thread` cannot compile. The 0.43 engine compiled on wasm because
that machinery didn't exist yet. This is upstream packaging, **not** a RedPash bug — and
no Cargo *feature* flag reaches it, because the offending deps are unconditional.

## The fix (live on lean)

A thin RedPash fork — **`doumouya/polars-rp`** — consumed via a single
`[patch.crates-io]` in [`backend/Cargo.toml`](../../../backend/Cargo.toml):

```toml
[patch.crates-io]
polars = { git = "https://github.com/doumouya/polars-rp", rev = "0bb178d6ea1239ba009ca69a569ea66871b8a328" }
```

Patching the umbrella to the *git* fork cascades to every sub-crate because the fork keeps
the intra-workspace `path`-deps (a *published* crate has its paths stripped on publish —
which is exactly why an umbrella-only published-vendor patch would silently fail to reach
`polars-core`).

The fork's divergence is **one commit, ~110 lines across 11 files** — keep the async paths
*compiling* (they're never reached on wasm) and remove only the wasm-fatal leaves:

- **`polars` umbrella** — drop `streaming` from the `csv` feature (RedPash uses
  collect-based lazy, not the streaming engine) → removes `polars-stream` / `object_store`.
- **`polars-io`** — gate the unconditional `tokio` dep to non-wasm; on wasm take only
  `tokio["sync"]` (needed by the always-compiled `stream_buf_reader`). Gate the
  `tokio::fs`+mmap byte-source constructor and its `DynByteSourceBuilder::Mmap` arm off
  wasm.
- **`polars-core`** — gate its (code-unused) `tokio` dep off wasm.
- **`polars-async`** — build a **bare current-thread** tokio runtime on wasm
  (`Builder::new_current_thread().build()` — no `net`, no `rt-multi-thread`, and crucially
  **no `.enable_time()`**: the time driver is built eagerly and seeds itself with
  `std::time::Instant::now()`, which panics on wasm; `ASYNC` is dereffed on every collect,
  so it would crash the first filter/sort/group/sql). `block_in_place` /
  `block_in_place_on` run the closure/future directly. So `ASYNC` stays a *real* runtime on
  every target and the whole plan/lazy/scan layer compiles unchanged — the key move that
  stopped the cascade.
- **`data/src/wasm.rs`** (RedPash) — the 0.54 `Series` → `Column` API moves the host build
  also carries (`.into_column()`, `DataFrame::new_infer_height(Vec<Column>)`,
  `df.columns()` now yields `&[Column]`). On lean these are throughout the engine — see
  [`backend/crates/data/src/clean.rs`](../../../backend/crates/data/src/clean.rs) and the
  wasm boundary [`backend/crates/data/src/wasm.rs`](../../../backend/crates/data/src/wasm.rs).

The data crate's wasm vs host split is in
[`backend/crates/data/Cargo.toml`](../../../backend/crates/data/Cargo.toml): the host takes
the workspace `polars` (with `fmt` default), wasm takes `polars` with
`default-features = false` (drops `fmt` → `comfy-table` → `crossterm` terminal IO) plus the
`getrandom["wasm_js"]` wiring.

## Verification

When the fork landed (commits `690e2da` host migration, `a6d5d05` wasm fork wiring):
`cargo check --target wasm32-unknown-unknown -p data` clean (`cargo tree -i mio` → empty);
host `cargo check --workspace` + the `data` tests unaffected — every gate is
non-wasm-transparent. The mechanical wasm gate is `tools/purity-check.sh`
(`cargo check --target wasm32-unknown-unknown -p data` with
`RUSTFLAGS='--cfg getrandom_backend="wasm_js"'`); `tools/build-wasm.sh` produces the
browser cdylib. The lean `data` crate now carries 76 `#[test]`s, all on the same source
that compiles to both targets.

## Prevention / lessons

- **Invert from the leaf.** `cargo tree -i <leaf> -e features` finds the real enabler;
  reading the wall of errors top-down wastes time.
- **A target-gated dep is transparent to the other target** — host takes the full
  multi-thread runtime, wasm takes current-thread, from the *same* source. Prefer this
  over forking the *code* per surface.
- **Keep async code compiling, not deleted.** The runtime `if run_async` guards mean the
  cloud/async paths are dead on wasm anyway; making the *leaves* compile (vs gating every
  call site) kept the fork tiny and avoided touching plan/lazy/mem-engine.
- **git-fork vs published-vendor.** `[patch.crates-io]` to a git workspace cascades via
  path-deps; to a published-crate copy it does **not** (paths stripped on publish).
- **Compile ≠ runtime — SMOKE the engine.** `cargo check`, the release build, and
  wasm-bindgen all went green while `apply_filter` still hard-panicked at runtime
  (`Builder::new_current_thread().enable_time()` builds the time driver eagerly and seeds
  it with `std::time::Instant::now()`, fatal on wasm; `ASYNC` is dereffed on every collect).
  A node smoke (`initSync` + call EVERY export) + an adversarial review caught it.
  `enable_time()` is wrong on wasm even when the runtime is "never driven" — *construction*
  touches the clock. Always run the engine, and exercise the lazy-**collect** path
  (`parse_csv` is eager and misses it).
- **The host pin moves to the fork too.** `[patch]` is global, so the *server* also builds
  against `doumouya/polars-rp` — a 0.54.3-stamped dev snapshot, one point-release behind
  crates.io 0.54.4 at fork time. Host `cargo check` + the `data` tests pass, no regression
  observed; treat it as a documented pin and rebase forward on the next bump.

## Maintenance

Rebase the single patch commit on each polars bump; drop the `[patch.crates-io]` entry
entirely when upstream ships `wasm32-unknown-unknown` support. The forward-bump method,
the wasm32 trap, and the fork shape are codified in the `polars-upgrade` skill
(`.claude/skills/polars-upgrade/`); for the data crate's architecture see
[`data-engine.md`](../code/backend/data-engine.md), and for day-to-day polars code the
`redpash-polars` skill.
