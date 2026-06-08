---
title: "polars 0.54 would not compile for wasm32 (tokio→mio)"
order: 23
case_id: pending
section: Internal
severity: Sev2
last modified date: 2026-06-08
owner: Torv
---

# 0023 — polars 0.54 would not compile for `wasm32-unknown-unknown`

> Case filing deferred — the cases backend was unreachable when this was written.
> File a `task` case and backlink it here when it's back up.

## Problem Statement

The Polars 0.43 → 0.54 migration shipped for the **server** (`690e2da`: whole
workspace `cargo check` clean, 32 `data` tests pass), but the **browser** half of
"one engine, two surfaces" was blocked:
`cargo check --target wasm32-unknown-unknown -p data` failed with **48 errors, all
inside the `mio` crate** — which has no `wasm32-unknown-unknown` backend. Without a
wasm build the `data` engine can't run in the browser, so the client-side compute
surface (workspace client-sort, the investor-POC 101k-rows-2.2s path) was dead on
0.54.

## Troubleshooting steps

1. **Invert the dep graph from the leaf**, don't read errors top-down:
   `cargo tree --target wasm32-unknown-unknown -p data -i mio -e features`. mio's
   only parent is `tokio`; tokio's only parent (after step 2) is `polars-io`.
2. **First cut — `polars-io`'s tokio.** `polars-io/Cargo.toml` declared
   `tokio = { workspace = true }` **unconditionally**, even though every
   tokio-*using* module in it (`pl_async`, `cloud`, `file_cache`) is feature-gated
   behind `async`/`cloud`/`file_cache` — none of which RedPash enables. Gating that
   dep off wasm moved mio one level up.
3. **Whack-a-mole revealed the real shape.** mio reappeared via `polars-plan`, then
   the `net` feature traced to **two** unconditional enablers:
   `polars-core` (`tokio[fs,net,rt-multi-thread,…]`, *unused in polars-core's own
   code*) and `polars-async` (`tokio[net,rt-multi-thread,…]`, the actual async
   executor). Feature-unification turns `net` on for the whole shared tokio, so mio
   compiles for everyone.
4. **The async machinery is woven through the plan/scan layer.** `polars-plan`
   *requires* `polars-io/async` (hard dep), and `polars-plan`/`polars-lazy`/
   `polars-mem-engine` reference `polars_core::runtime::ASYNC` and
   `polars_io::utils::byte_source` from code that is only *runtime*-guarded by
   `if run_async` (cloud / `force_async`, both false on wasm) — not feature-gated.
   So you cannot simply turn `async` off; the unconditional references dangle.

## RCA

polars 0.54's new async/cloud/streaming engine made the async runtime
(`polars-async`, a tokio **multi-thread** executor + `std::thread`) an
**unconditional** dependency of `polars-core`, and wove `ASYNC` / async byte-sources
through the eager DSL→IR scan path. On `wasm32-unknown-unknown` there are no OS
threads and no socket layer, so tokio's `net` (→ mio) and `rt-multi-thread` cannot
compile. The 0.43 engine compiled on wasm because that machinery didn't exist yet.
This is upstream packaging, **not** a RedPash bug — and no Cargo *feature* flag
reaches it, because the offending deps are unconditional.

## Solution

Maintain a thin RedPash fork — **`doumouya/polars-rp`** (0.54.3) — consumed via a
single `[patch.crates-io] polars = { git = …, rev = 0bb178d6 }` in
`backend/Cargo.toml`. Patching the umbrella to the *git* fork cascades to every
sub-crate because the fork keeps intra-workspace `path`-deps (a *published* crate has
its paths stripped — which is exactly why the earlier umbrella-only vendor patch
silently failed to reach `polars-core`).

The fork's divergence is **one commit, ~110 lines across 11 files** — keep the async
paths *compiling* (they're never reached on wasm) and remove only the wasm-fatal
leaves:

- **`polars` umbrella** — drop `streaming` from the `csv` feature (we use
  collect-based lazy, not the streaming engine) → removes `polars-stream`/`object_store`.
- **`polars-io`** — gate the unconditional `tokio` dep to non-wasm; on wasm take only
  `tokio["sync"]` (needed by the always-compiled `stream_buf_reader`). Gate the
  `tokio::fs`+mmap byte-source constructor and its `DynByteSourceBuilder::Mmap` arm
  off wasm.
- **`polars-core`** — gate its (code-unused) `tokio` dep off wasm.
- **`polars-async`** — build a **bare current-thread** tokio runtime on wasm
  (`Builder::new_current_thread().build()` — no `net`, no `rt-multi-thread`, and
  crucially **no `.enable_time()`**: the time driver is built eagerly and seeds itself
  with `std::time::Instant::now()`, which panics on wasm — and `ASYNC` is dereffed on
  every collect, so it would crash the first filter/sort/group/sql). `block_in_place`/
  `block_in_place_on` run the closure/future directly. So `ASYNC` stays a *real* runtime
  on every target and the whole plan/lazy/scan layer compiles unchanged — the key move
  that stopped the cascade.
- **`data/src/wasm.rs`** (RedPash) — two 0.54 API fixes the host never exercised:
  `Vec<Series>` → `Vec<Column>` + `.into_column()` for `DataFrame::new_infer_height`,
  and `df.columns()` now yields `&[Column]` so collect into `Vec<&Column>`.

Verified: `cargo check --target wasm32-unknown-unknown -p data` clean
(`cargo tree -i mio` → empty); host `cargo check --workspace` + `cargo test -p data`
(32 pass) unaffected — every gate is non-wasm-transparent.

## Prevention / lessons

- **Invert from the leaf.** `cargo tree -i <leaf> -e features` finds the real
  enabler; reading the wall of errors top-down wastes time.
- **A target-gated dep is transparent to the other target** — host took the full
  multi-thread runtime, wasm took current-thread, from the *same* source. Prefer this
  over forking the *code* per surface.
- **Keep async code compiling, not deleted.** The runtime `if run_async` guards mean
  the cloud/async paths are dead on wasm anyway; making the *leaves* compile (vs
  gating every call site) kept the fork tiny and avoided touching plan/lazy/mem-engine.
- **git-fork vs published-vendor.** `[patch.crates-io]` to a git workspace cascades
  via path-deps; to a published-crate copy it does **not** (paths stripped on publish).
- **Compile ≠ runtime — SMOKE the engine.** `cargo check` + the release build +
  wasm-bindgen all went green while `apply_filter` still hard-panicked at runtime
  (`Builder::new_current_thread().enable_time()` — tokio builds the time driver
  eagerly and seeds it with `std::time::Instant::now()`, fatal on wasm; `ASYNC` is
  dereffed on every collect). A node smoke (`initSync` + call EVERY export) + an
  adversarial review caught it. `enable_time()` is wrong on wasm even when the runtime
  is "never driven" — *construction* touches the clock. Always run the engine, and
  exercise the lazy-**collect** path (parse_csv is eager and misses it).
- **Host pin = fork 0.54.3, not crates.io 0.54.4 (deliberate, low-risk).** The
  `[patch]` is global, so the *server* also moves to the fork — a 0.54.3-stamped dev
  snapshot (base `1c1155555`, 2026-06-05), one point-release behind crates.io 0.54.4.
  32 data tests + host `cargo check` pass, no regression observed; treat as a
  documented pin. On the next bump, rebase onto the 0.54.4+ tag and re-check.
- **Maintenance.** Rebase the single patch commit on each polars bump; drop the patch
  entirely when upstream ships `wasm32-unknown-unknown` support. Playbook:
  `.claude/skills/polars-upgrade`.
