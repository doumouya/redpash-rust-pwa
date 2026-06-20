---
name: polars-upgrade
description: >
  Playbook for BUMPING the polars / polars-sql version in RedPash's backend (the
  data + api crates). Lean is ALREADY on polars 0.54 + the `doumouya/polars-rp`
  fork — so this is the FORWARD-bump playbook (next: 0.54→0.5x), with the
  just-proven 0.43→0.54 migration kept as the worked precedent. It carries the
  verify-EVERY-target loop and the wasm32 "tokio→mio" trap + the fork fix. Use
  this whenever you change the `polars` or `polars-sql` version in `backend/Cargo.toml`;
  see a polars future-incompat / deprecation warning; a polars bump breaks
  `cargo check`; or the wasm build fails after a polars bump (mio / tokio / wasm32
  errors). Reach for it even if the user just says "upgrade polars", "move to polars
  0.x", "polars won't build for wasm", or "fix the polars deprecation warning"
  without naming this skill. This is the MIGRATION playbook; for writing day-to-day
  polars code use `redpash-polars`, and for the data crate's architecture read the
  live doc `docs/internal/code/backend/data-engine.md`.
---

# Polars upgrade playbook (RedPash)

RedPash's `data` crate compiles **twice** — an rlib for the server and a wasm cdylib
for the browser ("one engine, two surfaces"). A polars bump is therefore done when
**all** of host check, host tests, *and* the wasm32 build are green — not when the
server compiles. This skill is the method + the two hard-won specifics so you don't
rediscover them.

**Lean's current state (the starting line, not a target):** polars **0.54** is the
floor, consumed via the **`doumouya/polars-rp`** git fork — see `backend/Cargo.toml`
(`polars = { version = "0.54", … }` + `[patch.crates-io] polars = { git = "…/polars-rp",
rev = "0bb178d6…" }`). The 0.43→0.54 API migration described below is **DONE**; it lives
here as the proven precedent for the *next* bump. When you move 0.54→0.5x, the **method**
and the **wasm32-fork shape** are what transfer — re-derive the API deltas against the
new version's changelog, and rebase the fork's single patch commit.

Lean on the compiler (`rust` skill) and the polars API map (`redpash-polars` skill,
`references/api-index.md` has an exact docs.rs URL per item) — this skill is the
*process* and the *version-specific deltas*.

## Method — spike, fix, verify every target, ship the host slice early

This loop is timeless; it's what survives the version churn.

1. **Spike & measure first.** Bump the version in `backend/Cargo.toml` (both the
   workspace `polars` and the `[target.'cfg(target_arch = "wasm32")']` `polars` line in
   `backend/crates/data/Cargo.toml` — they're two separate declarations, see below),
   run `cargo check --workspace`, and *count + categorize* the errors before committing
   to the work. Most are a handful of mechanical renames repeated N times.
2. **Compiler-as-oracle fix loop.** Fix by category, re-check. Don't guess a signature —
   `redpash-polars`'s `references/api-index.md` has the exact docs.rs URL per item; WebFetch it.
3. **Verify EVERY target — this is the gate (lean's actual tools):**
   - `sh tools/purity-check.sh` — the canonical wasm32 gate:
     `RUSTFLAGS='--cfg getrandom_backend="wasm_js"' cargo check --target wasm32-unknown-unknown -p data`.
     This is the binding rule (CLAUDE.md): the data crate must be wasm32-clean at every commit.
   - `sh tools/ci.sh` — the whole host gate (it runs `purity-check`, then
     `cargo check --workspace`, then `cargo test --workspace`, then the audit ratchet +
     FE build). One command covers host check + host tests.
   - `cargo test -p data` (from `backend/`) — the engine behavior in isolation when you
     just want the data-crate tests, not the full workspace.
   - `cargo tree --target wasm32-unknown-unknown -p data -i mio` → **must be empty**
     (the wasm32 trap tripwire — see below).
   - `tools/build-wasm.sh` → fresh content-hashed `frontend/wasm/data_bg.<hash>.wasm`
     (the 4-stage pipeline: wasm32 build → wasm-bindgen → wasm-opt -Oz → content-hash rename).
   - `node tools/wasm-smoke.mjs` — **run this AFTER `tools/build-wasm.sh`**. It loads the
     built engine in a node host, enumerates every export, and exercises `parse_score` +
     a lazy-collect path. This is what catches the **runtime** fork panic (`.enable_time`)
     that a green `cargo check` hides. It is deliberately **not** in `ci.sh` (no built blob
     in a fresh clone) — you must run it by hand on any engine/fork change.
4. **Commit the host slice early.** The host migration is independently valuable and
   the wasm port can be long — land host first (an uncommitted tree was lost to an
   accidental delete once). Commit before any risky/long op. (`git commit -o <files>`
   only — concurrent sessions' WIP is in the tree.)
5. **Bug→case→runbook.** A non-trivial bump gets a case at discovery and a runbook when
   fixed (`docs/internal/runbooks/NNNN-*.md` if/when that dir is seeded in lean — it
   isn't yet; the predecessor's runbook 0023 is the precedent). Until then, the live home
   for the wasm-fork WHY is the comment block in `backend/Cargo.toml` plus the smoke-test
   note in `docs/internal/code/frontend/conventions.md`. Keep both truthful in the same
   commit, and update the `redpash-polars` skill if the API surface or the wasm fork changed.

## The 0.43 → 0.54 API recipe (the worked precedent — DONE in lean)

This migration already landed. Keep it as the reference for *how a polars bump churns*:
each item is a find-and-fix repeated across the crate. Full worked list with before/after
in [`references/polars-0.43-to-0.54.md`](references/polars-0.43-to-0.54.md). For the next
bump, re-derive the equivalent table against the new version's changelog.

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
> migration won't compile them, so they surface only on the wasm32 check. We hit
> exactly this in `data/src/wasm.rs` — `Vec<Series>`→`Vec<Column>` + `.into_column()` —
> *after* host was already green. The whole `wasm.rs` module is `#![cfg(target_arch =
> "wasm32")]`; its exports are the `parse_score` free fn + the `Workbook` impl
> (`from_csv` / `page` / `filter_page` / `view` / `score` / `sql` / `rows` / `cols`),
> so a polars signature change in any path those reach only surfaces on `purity-check`.

## The wasm32 trap (polars ≥ 0.54) — and the fix

**Symptom:** after the API migration, `sh tools/purity-check.sh`
(`cargo check --target wasm32-unknown-unknown -p data`) fails with dozens of errors
**all inside `mio`** (no wasm32 backend).

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
[`references/polars-0.43-to-0.54.md`](references/polars-0.43-to-0.54.md) §wasm. The WHY
now lives in lean at the `backend/Cargo.toml` comment block above the `[patch.crates-io]`
stanza and in `docs/internal/code/frontend/conventions.md` (the smoke-test note);
the original post-mortem was the predecessor's runbook `0023-polars-0.54-wasm-fork.md`.
Headlines:

- Drop `streaming` from the umbrella `csv` feature (collect-based lazy, not the streaming engine).
- Target-gate the *unused / file / net* tokio deps off wasm (polars-core, polars-io);
  give wasm only `tokio["sync"]` where an always-compiled module needs it.
- Give **`polars-async` a current-thread tokio runtime on wasm** — this keeps `ASYNC` a
  real type on every target so the whole plan/lazy/scan layer compiles unchanged. This is
  the move that stops the cascade; gating every *call site* instead is a far bigger diff.
- **Do NOT `.enable_time()`** on the wasm runtime: tokio seeds the time driver with
  `std::time::Instant::now()`, which PANICS on wasm32 — and `ASYNC` is dereffed on *every*
  collect, so it crashes the engine on the first filter/sort/group/sql even though a
  green `cargo check` passed. **This is the bug `node tools/wasm-smoke.mjs` exists to
  catch** — a behavioral runtime check the type-checker cannot.
- `[patch]` the **git** fork (not a published-crate vendor): the git workspace keeps
  intra-workspace `path`-deps so one umbrella patch cascades to every sub-crate; a
  published crate has its paths stripped and the patch silently misses `polars-core`.

**Two Cargo.toml declarations to keep in lockstep.** The server build pulls polars from
the workspace dep in `backend/Cargo.toml`; the wasm build overrides it with
`default-features = false` in `backend/crates/data/Cargo.toml`'s
`[target.'cfg(target_arch = "wasm32")']` block (drops `fmt` → no comfy-table → no
crossterm terminal IO on wasm). A bump must touch **both** version pins, and the
`[patch.crates-io]` git rev applies to both surfaces.

**Maintenance:** rebase the fork's single patch commit on each polars bump; drop the
patch entirely when upstream ships `wasm32-unknown-unknown` support (re-check on each bump).

## polars-sql

The deprecation that triggered the 0.43→0.54 move was in `polars-sql`. RedPash wraps the
read-only SQL surface in `backend/crates/data/src/sql.rs` (`run_sql` → `SQLContext` +
the `is_read_only` allowlist; the result is capped by `crate::ROW_CAP`, re-exported as
`SQL_RESULT_ROW_CAP`). It compiles on **both** surfaces (the wasm polars carries the
`sql` feature, +~7 MiB raw / +~1 MiB gz — a cost accepted per
`docs/decisions/client-data-engines.md`), and is exposed client-side as `Workbook.sql`.
The exact items RedPash uses (`SQLContext`, `sql_expr`, `function_registry`, `keywords`)
and their docs.rs links are in [`references/polars-sql-0.54.md`](references/polars-sql-0.54.md).

## Where the current direction lives (don't hardcode — point at the source)

These live docs are the source of truth; read them rather than trusting any version
number frozen into this skill (so the skill can't re-stale):

- `docs/REDMAP.md` — the doc⇄code map (which doc covers which code area).
- `docs/decisions/client-data-engines.md` — why Polars (wasm) is the compute engine, the
  GlueSQL split, and the accepted SQL bundle cost.
- `docs/decisions/day-one.md` — the locked decisions (content-hash for ALL static assets,
  the one-`FilterNode`/`QuerySpec` contract the wasm wrapper consumes).
- `docs/internal/code/backend/data-engine.md` — the data crate's architecture (`steps/`,
  `group_by`, `wasm`), replacing the never-installed `rust-data-engine` skill the older
  draft cited.
- `backend/Cargo.toml` + `backend/crates/data/Cargo.toml` — the two live polars pins +
  the fork patch + the wasm feature override.
