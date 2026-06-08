---
name: polars-upgrade
description: >
  Playbook for BUMPING the polars / polars-sql version in RedPash's backend (the
  data + api crates) — the 0.43→0.54 API migration recipe, the verify-every-target
  loop, and the wasm32 "tokio→mio" trap + the RedPash polars-fork fix. Use this
  whenever you change the `polars` or `polars-sql` version in Cargo.toml; see a polars
  future-incompat / deprecation warning; a polars bump breaks `cargo check`; or the
  wasm build fails after a polars bump (mio / tokio / wasm32 errors). Reach for it even
  if the user just says "upgrade polars", "move to polars 0.x", "polars won't build for
  wasm", or "fix the polars deprecation warning" without naming this skill. This is the
  MIGRATION playbook; for writing day-to-day polars code use `redpash-polars`, and for
  the data crate's architecture use `rust-data-engine`.
---

# Polars upgrade playbook (RedPash)

RedPash's `data` crate compiles **twice** — an rlib for the server and a wasm cdylib
for the browser ("one engine, two surfaces"). A polars bump is therefore done when
**all** of host check, host tests, *and* the wasm32 build are green — not when the
server compiles. This skill is the method + the two hard-won specifics (the 0.43→0.54
API churn and the wasm32 trap) so you don't rediscover them.

Lean on the compiler (`rust` skill) and the polars API map (`redpash-polars` skill) —
this skill is the *process* and the *version-specific deltas*.

## Method — spike, fix, verify every target, ship the host slice early

1. **Spike & measure first.** Bump the version in `backend/Cargo.toml`, run
   `cargo check --workspace`, and *count + categorize* the errors before committing to
   the work. Most are a handful of mechanical renames (see the recipe) repeated N times.
2. **Compiler-as-oracle fix loop.** Fix by category, re-check. Don't guess a signature —
   `redpash-polars`'s `references/api-index.md` has the exact docs.rs URL per item; WebFetch it.
3. **Verify EVERY target — this is the gate:**
   - `cargo check --workspace` (host)
   - `cargo test -p data` (behavior — the 32 data tests)
   - `RUSTFLAGS='--cfg getrandom_backend="wasm_js"' cargo check --target wasm32-unknown-unknown -p data`
   - `cargo tree --target wasm32-unknown-unknown -p data -i mio` → **must be empty**
   - `tools/build-wasm.sh` → fresh content-hashed `frontend/wasm/data_bg.<hash>.wasm`
4. **Commit the host slice early.** The host migration is independently valuable and
   the wasm port can be long — land host first (we lost an uncommitted tree to an
   accidental delete once). Commit before any risky/long op.
5. **Bug→case→runbook.** A non-trivial bump gets a runbook (`docs/internal/runbooks/`),
   and update the `redpash-polars` skill if the API surface or the wasm fork changed.

## The 0.43 → 0.54 API recipe (just-proven, mechanical)

Apply by category; each is a find-and-fix repeated across the crate. Full worked list
with before/after in [`references/polars-0.43-to-0.54.md`](references/polars-0.43-to-0.54.md).

- `df.get_columns()` → `df.columns()` — now yields `&[Column]`, **not** `&[Series]`.
- **Column ↔ Series:** `column.as_materialized_series()` (→ `&Series`),
  `series.into_column()` (→ `Column`). `Column` has `.str()/.bool()/.i64()/.f64()/.get(i)`
  directly — you usually don't need to round-trip through Series.
- `with_column(col)` and `DataFrame::new(cols)` → `DataFrame::new_infer_height(cols)`,
  both take `Column`/`Vec<Column>`.
- `ChunkedArray` is no longer `IntoIterator` → call `.iter()`.
- `QuantileInterpolOptions` → `QuantileMethod`.
- `Expr::over(...)` now returns `PolarsResult<Expr>` → add `?`.
- `join(...)` gained a trailing `Option<JoinTypeOptions>` arg → pass `None`.
- `Expr::forward_fill` → `fill_null_with_strategy(FillNullStrategy::Forward(None))`.
- `lit(LiteralValue::Null)` → `lit(Null {})`.
- `drop` / `drop_nulls` take a `Selector` (`cols(...)` / `by_name(names, strict, expand)`).
- **`rename(old, new, strict_bool)`** — gained the strict bool.

> Watch the **wasm-only code paths** (`#[cfg(target_arch = "wasm32")]`): the host
> migration won't compile them, so they surface only on the wasm32 check. (We hit
> exactly this in `data/src/wasm.rs`: `Vec<Series>`→`Vec<Column>` + `.into_column()`.)

## The wasm32 trap (polars ≥ 0.54) — and the fix

**Symptom:** after the API migration, `cargo check --target wasm32-unknown-unknown -p data`
fails with dozens of errors **all inside `mio`** (no wasm32 backend).

**Diagnose from the leaf, not the wall of errors:**
```
cargo tree --target wasm32-unknown-unknown -p data -i mio -e features
```
`mio ← tokio ← polars-io` (and the `net` feature is force-enabled by `polars-core` +
`polars-async`, which `polars-plan` hard-requires). polars 0.54 made the async/cloud
runtime an **unconditional** dep of `polars-core` and wove `ASYNC` + async byte-sources
through the eager scan path — so **no Cargo feature flag reaches it**. It needs a fork.

**Fix (already in place):** the RedPash polars fork **`doumouya/polars-rp`**, consumed via
`[patch.crates-io] polars = { git = …, rev = … }` in `backend/Cargo.toml`. The principle:
**keep the async paths compiling** (they're runtime-guarded by `if run_async`, false on
wasm — never reached) and remove only the wasm-fatal leaves. The full patch recipe (the
11-file, ~110-line diff to re-apply on the next bump) is in
[`references/polars-0.43-to-0.54.md`](references/polars-0.43-to-0.54.md) §wasm, and the
post-mortem is runbook `0023-polars-0.54-wasm-fork.md`. Headlines:

- Drop `streaming` from the umbrella `csv` feature (collect-based lazy, not the streaming engine).
- Target-gate the *unused / file / net* tokio deps off wasm (polars-core, polars-io);
  give wasm only `tokio["sync"]` where an always-compiled module needs it.
- Give **`polars-async` a current-thread tokio runtime on wasm** — this keeps `ASYNC` a
  real type on every target so the whole plan/lazy/scan layer compiles unchanged. This is
  the move that stops the cascade; gating every *call site* instead is a far bigger diff.
- `[patch]` the **git** fork (not a published-crate vendor): the git workspace keeps
  intra-workspace `path`-deps so one umbrella patch cascades to every sub-crate; a
  published crate has its paths stripped and the patch silently misses `polars-core`.

**Maintenance:** rebase the fork's single patch commit on each polars bump; drop the
patch when upstream ships `wasm32-unknown-unknown` support.

## polars-sql

The deprecation that triggered the 0.43→0.54 move was in `polars-sql`. The SQL surface
RedPash wraps (`SQLContext`, `sql_expr`, `function_registry`, `keywords`) and its docs.rs
links are in [`references/polars-sql-0.54.md`](references/polars-sql-0.54.md).
