---
title: Rust refactor audit
section: Refactor
last modified date: 2026-05-22
superseded-by: tools/rs-audit/ — recurring audit replaces the one-shot review
---

# Rust refactor audit

A survey of refactors that pay for themselves without changing
behaviour. **Refreshed 2026-05-22** — supersedes the 2026-05-19 draft.
This pass verified the earlier `api`-crate findings against the current
code (they hold — counts inline), added the `data` crate that the
earlier draft skipped, and reconciled the list with the object-model
hard-refresh and the incoming redtable migration.

Workspace: **10,068 LOC of Rust** across `api` / `data` / `shared`. The
mass is in four files — `db.rs` 1864 · `routes/files.rs` 1284 ·
`data/steps.rs` 973 · `data/parse.rs` 576.

Scope note: this doc is **structural refactors only**. Correctness /
security / perf bugs are tracked separately in `fix-to-do.md`.

## What's solid — don't touch

- The 3-crate split (`api` / `data` / `shared`): `data` has no HTTP
  deps, `shared` is dependency-light DTOs, every wire shape in one place.
- One route module per resource, mirroring the URL tree.
- `error.rs` centralises `AppError` + `From<DataError>` + `From<anyhow::Error>`.
- Workspace dependency pinning in `backend/Cargo.toml`.
- `id.rs`, `bootstrap.rs`, `health.rs`, `dedup.rs`, `clean.rs` — small
  and clean; leave them.

## Out of scope — the hard-refresh owns these

`routes/reports.rs` (432 LOC), `routes/dashboards.rs` (152), and the
report-specific DTOs in `shared/report.rs` are **slated for deletion /
folding** by the object-model hard-refresh
(`docs/internal/object-model-hard-refresh.md`): the `reports` table is
dropped, `dashboards` folds into `project_files`, `/api/charts` is the
canonical surface. **Do not refactor them** — refactoring code that is
about to be deleted is wasted work. The audit below excludes them.
(`/api/reports/preview`, the stateless grouping engine, survives
renamed — the one piece worth carrying forward.)

## `api` crate — targets

Counts verified 2026-05-22.

### 1. `From<sqlx::Error> for AppError` · 79 sites
Every DB call site is `.map_err(|e| AppError::internal("db", e.to_string()))?`
— **79 occurrences**. One impl in `error.rs` lets `?` propagate them:
```rust
impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self { AppError::internal("db", e.to_string()) }
}
```
Same wire shape (`kind:"db"`), ~79 lines of ceremony gone.
**Watch-out:** keep the explicit UNIQUE-violation match arms in
`users.rs` + `companies.rs` (23505 → `username_taken` / `slug_taken`)
— the `From` impl handles only the default path.

### 2. `blocking()` helper · 18 sites in files.rs
`spawn_blocking(move || -> Result<_, DataError> {…}).await.map_err(…)??`
repeats **18×** in `files.rs` alone. Wrap once in `api/src/util.rs`
(`blocking<T,F>(f) -> Result<T, AppError>`); six-line call sites
collapse to one. Keep `DataError` concrete in the signature so the
`From<DataError>` wire-mapping (Polars / encoding / IO → 400/500) is
preserved.

### 3. `AppError::{db,join,io}` constructors
Pairs with #1, for the closure-internal sites `From` can't reach.
`AppError::db(e)` reads better than `AppError::internal("db", e.to_string())`.

### 4. Split `routes/files.rs` · 1284 LOC, 23 handlers
The api crate's navigation pain. Split into a `files/` directory
mirroring the URL grouping — `upload.rs`, `page.rs`, `steps.rs`,
`joins.rs`, `derive.rs` (snapshot / export / dedup / uniques /
sentinels / cleanness / encoding), `hydrate.rs` — ~150–250 LOC each.
Pure code motion; bump `hydrate` `pub(super)` → `pub(crate)`.

### 5. Split `db.rs` · 1864 LOC
Every SQL helper in one file. Split into `db/` mirroring the route
modules (`db/{users,sessions,projects,files,steps,companies,sentinels}.rs`),
re-exported from `db/mod.rs` so every `db::find_file(...)` call site is
unchanged. Per-resource files become the natural home for the
scattered `FromRow` impls. Pure code motion, zero behavioural risk.

### 6. `require_owned<R>` trait · 47 sites
`resolve_user_rid` + `ensure_owner(db::*_owner(...))` — the same two
lines **47×** across detail handlers. An `OwnedResource` trait
collapses the call site to
`let user = require_owned::<File>(&state, &headers, &rid).await?;`.
Trait over macro — compile-time visible. The companies path uses
`require_member` (returns a role) — different shape, leave it.

### 7. `Option<String>::sanitize()`
`body.field.as_deref().map(str::trim).filter(|s| !s.is_empty())` —
dozens of times across PATCH handlers. A one-method extension trait
halves the width of every sparse-update handler.

### 8. Resolve `render.rs` · dead stub + 4 unused deps
`data/src/render.rs` is a 2-line TODO stub, yet `lib.rs` declares
`pub mod render` and the workspace pins four deps for it — `maud`,
`pulldown-cmark`, `syntect`, `gray_matter`. `routes/docs.rs` (136 LOC)
serves `/api/docs` — **confirm whether it uses `render.rs`**; if not,
the stub + its 4 deps are pure dead weight. Recommendation: delete
both unless `/api/docs` markdown rendering is near-term.

## `data` crate — targets (new this pass)

The earlier draft skipped this crate. It holds the single heaviest
refactor in the backend.

### 9. `steps::apply` — make the 18-kind dispatch table-driven · THE big one
`steps.rs::apply` is a **646-line `match kind`** (lines ~45–691) over
18 step kinds — entries averaging 35 lines, each inlining its own
param-parsing, validation, and Polars-expr construction. It is not a
function, it is a dispatch table written as code. The
`with_columns([expr]).collect()` tail alone repeats verbatim across ~9
kinds. Refactor: a `StepKind` trait (or a `(name, fn)` registry) —
each kind becomes a small, individually-testable function; the kind
list becomes **data, not a match**. This is the exact "factor to the
atom, parameterize the one varying axis" pattern — the varying axis is
the per-kind transform; everything around it is identical.

### 10. `av_to_string()` — one helper kills 8+ copies · crate-wide
The `AnyValue` → `Option<String>` stringify match is **copy-pasted 8+
times** — `stats.rs` (×2), `parse.rs`, `dtype.rs`, `joins.rs`,
`dedup.rs`, `steps.rs` (×2). The clearest factor-to-the-atom win in the
crate: one `av_to_string(&AnyValue) -> Option<String>` in `lib.rs`.
Cheap, mechanical, high-leverage.

### 11. Unify the two filter-predicate builders · largest cross-file dup
`parse.rs::filter_expr` (~420–494) and `steps.rs::build_filter_predicate`
(~740–853) are **two complete parallel implementations** of "op + value
→ Polars `Expr`" — one typed (`FilterOp`, the `/page` endpoint), one
string-keyed (the `filter_rows` step), with near-identical numeric /
string / between / null handling. Collapse to one predicate builder
both call. (Relevant to the migration: the redtable's filter panel
wires to `/page`, i.e. `filter_expr`.)

### 12. `group_by` aggregation dispatch — 3 copies → 1 table
`build_agg_exprs` + `default_alias` are two parallel 11-arm matches
over `AggFn`; `apply_windows` carries a **third**, string-keyed copy
with two `unreachable!()` panics. Make `AggFn` own its `(Expr, alias)`
mapping; put the window variant on the same enum instead of strings.

### 13. One canonical `SENTINELS` list · latent bug
`stats.rs::SENTINELS` and `dtype.rs::SENTINEL_TOKENS` are **two
divergent** canonical junk-token lists (`dtype` carries an extra
`"nd"`). Two sources of truth for "what counts as junk" is a real
correctness risk — unify to one, consumed by `stats`, `dtype` and
`clean.rs::is_junk` alike.

### 14. Smaller `data` dups
- `steps.rs`: a `drop_named(df, &[&str])` helper (3 kinds rebuild the
  same HashSet+filter idiom); `rename_via(|old| -> String)` (the kinds
  `snake_case_columns` and `replace_in_names` are byte-for-byte
  identical bar the transform); a scalar `req_str` param helper (~15
  sites); `fold_bool` for the repeated OR/AND expr folds.
- `parse.rs`: `DELIMS` declared 3× (incl. `steps.rs`); `parse_text` is
  a 107-line function doing three jobs (sniff / wrapped-detect / read)
  — split it; lift `unwrap_csv` (a 128-line arm with 4 nested fns) into
  its own module.
- `export.rs`: `write_cell` and `any_value_to_json` are the same typed
  dispatch written twice — one `classify(&AnyValue)` feeding both.
- `encoding.rs`: the `tld` hint param is dead (`.and_then(|_| None)`
  forces it to `None`) — wire it or drop it.
- Stale doc-comments: `steps.rs` header still says split / join / dates
  "land in Phase A.2" (all shipped); `lib.rs` says "most modules are
  stubbed" (only `render` is). Fix in the same pass that touches them.

## Priority & sequencing

The redtable migration is incoming; the backend lane does the wiring +
the hard-refresh. Sequence the audit around that:

| When | Items | Why |
|---|---|---|
| **With the migration wiring** | 1, 2, 3 · 10 · 13 | The error helpers make every new endpoint clean from line one; #13 is a latent bug, fix on sight; #10 is mechanical. ~1 day. |
| **Rides with the hard-refresh** | 4, 5 (split `files.rs` / `db.rs`) | Pure code motion, big diffs — but the backend lane is single-owner (no conflict with Woz), so split while those files are open anyway. |
| **After the surface lands** ("eventual") | 9 · 11 · 12 · 6 · 7 · 14 · drop `PageQuery::{sort,dir}` legacy fields once the redtable (multi-key `sorts`) is the only client | Behaviour-preserving internal refactors — real debt, no urgency. #9 is the biggest single win. |
| **Decide** | 8 (`render.rs` + 4 deps) | One ruling: wire `/api/docs` through it, or delete stub + deps. |
| **Defer** | `ChartSpec` tagged union (`shared/report.rs`, ~70 LOC, 14 kind-specific optionals) — cleaner as an enum, but breaks every saved spec in the DB. Not worth the churn. |

## Not worth doing

- A `crud!()` macro to auto-generate handlers — opaque, locks the call shape.
- A generic envelope cache — only files use it; premature.
- Migration `CHECK (role IN …)` dedup — company roles ≠ project roles; leave inline.
- `PROJECT_SELECT` format-spliced WHERE fragments — static strings, theoretical risk only.

## Watch-outs

- `From<sqlx::Error>` collapses the DB error *code* into a string —
  keep it **alongside** the UNIQUE-violation match arms, not replacing
  them.
- `blocking()` must keep the JoinError (→500) vs DataError (→400/500
  via `From`) distinction — don't collapse to one `?` over a boxed error.
- Splitting `files.rs` / `db.rs` is zero behavioural risk but large
  diffs — fine here only because the backend lane is single-owner
  during the migration.
- **#9 (`steps::apply`) touches the cleaner's core.** It is
  behaviour-preserving, but every step kind needs a test before and
  after. The cleaner is RedPash's crown jewel — refactor it with a net.
- DTO field renames in `shared/` break cached envelopes (the
  localStorage cache) — bump the cache version alongside any `shared/`
  change.

---

## Refresh notes — 2026-05-22

The 2026-05-19 draft's `api`-crate analysis was verified against
current code and holds (79 `map_err("db")`, 18 `spawn_blocking` in
files.rs, 47 owner-checks, `render.rs` still a 2-line stub,
`From<sqlx::Error>` still absent). `db.rs` and `files.rs` both grew
~15% since — the split items are more justified, not less. The `data`
crate (items 9–14) is new this pass — the earlier draft never read it,
and `steps::apply` turned out to be the heaviest single target in the
backend. Reports / dashboards were re-classified out of scope: the
hard-refresh deletes them.

— Gus
