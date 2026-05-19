# Plan: Rust factorisation

Survey of refactors that pay for themselves quickly without changing
behaviour. File refs are to prerelease; numbers from a full read of
the workspace (`api` 36 files / 8.4k LOC, `data` 9 src files / 2.6k
LOC, `shared` 9 src files / 0.7k LOC, 10 migrations / 0.3k LOC).

---

## What's there today

**Structure is good already:**
- 3-crate split (`api` / `data` / `shared`) is clean — `data` has no HTTP deps, `shared` is dependency-light DTOs, every wire shape is in one place.
- One route module per resource (`auth`, `me`, `projects`, `files`, `reports`, `dashboards`, `users`, `companies`, `health`) mirroring the URL tree. Easy to audit.
- Workspace dependency pinning in `backend/Cargo.toml` keeps Polars / Axum / sqlx versions in lockstep across crates.
- `error.rs` already centralises `AppError` + `From<DataError>` + `From<anyhow::Error>`. Wire shape matches `shared::ApiError`.
- `env-swap.sh` is a sweet branch-aware env switcher (main ↔ prerelease).

**Repetition that adds up across handlers:**
- `.map_err(|e| AppError::internal("db", e.to_string()))` after every sqlx call — ~80 occurrences.
- `tokio::task::spawn_blocking(move || -> Result<_, DataError> { … }).await.map_err(|e| AppError::internal("join", e.to_string()))??` — ~20 occurrences in `files.rs` alone.
- `resolve_user_rid` + `ensure_owner(db::*_owner(...))` two-line dance — ~40 occurrences across detail handlers.
- `body.field.as_deref().map(str::trim).filter(|s| !s.is_empty())` — dozens of occurrences across PATCH handlers.

**Files that have grown:**
- `routes/files.rs` — 1197 LOC, 19 handlers in one file.
- `db.rs` — 1620 LOC, every SQL helper in one file.

**Dead / stub code spotted:**
- `data/src/render.rs` — 2-line stub (`TODO: implement in phase 2-3`), but `lib.rs` declares it as a public module AND the REDMAP / cleaner-page docs claim `/api/docs` exists. The route doesn't.
- `shared/file::PageQuery` carries both `sort + dir` (legacy single-key) and `sorts` (multi-key JSON) — both currently honoured by `parse::page`, with multi taking precedence.

---

## Tier 1 — High leverage, low risk (~½ day total)

### 1. `From<sqlx::Error> for AppError`

Today every DB call site is `.map_err(|e| AppError::internal("db", e.to_string()))`. Add one impl in `crates/api/src/error.rs`:

```rust
impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::internal("db", e.to_string())
    }
}
```

Now `?` propagates sqlx errors. Same wire shape (`kind: "db"`), ~80 lines of ceremony gone across handlers + helpers.

**Watch-out:** keep the existing explicit `match` arms for UNIQUE violations in `routes/users.rs:70-72`, `routes/companies.rs:172-174`. The `From` impl handles the default path; the specialised cases still need their match (23505 → `username_taken` / `slug_taken`).

### 2. `blocking()` helper for `spawn_blocking + DataError`

The pattern repeats ~20 times in [files.rs](backend/crates/api/src/routes/files.rs) alone:

```rust
tokio::task::spawn_blocking(move || -> Result<_, data::DataError> { ... })
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))??;
```

Wrap once in `api/src/util.rs`:

```rust
pub async fn blocking<T, F>(f: F) -> Result<T, AppError>
where
    F: FnOnce() -> Result<T, data::DataError> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::internal("join", e.to_string()))?
        .map_err(AppError::from)
}
```

Six-line call sites collapse to one. Two error layers preserved (JoinError → 500, DataError → 400/500 via existing `From<DataError>`).

**Watch-out:** don't try to make it generic over the inner `Result<_, E>` — keep DataError specific, since the wire mapping is via `From<DataError>` which knows how to bucket Polars / encoding / IO. A blanket-typed helper would lose those distinctions.

### 3. `AppError` constructors for common patterns

Pair with #1. Where `From` can't apply (closure-internal maps, anyhow wrappers):

```rust
impl AppError {
    pub fn db(e:   impl ToString) -> Self { Self::internal("db",   e.to_string()) }
    pub fn join(e: impl ToString) -> Self { Self::internal("join", e.to_string()) }
    pub fn io(e:   impl ToString) -> Self { Self::internal("io",   e.to_string()) }
}
```

`AppError::db(e)` reads better than `AppError::internal("db", e.to_string())`. Used at ~30 sites that the `From<sqlx::Error>` impl from #1 doesn't reach.

---

## Tier 2 — Navigation wins (~½ day each)

### 4. Split [files.rs](backend/crates/api/src/routes/files.rs) (1197 LOC → 6-7 files of ~150-250)

This single file is the api crate's navigation pain. Suggested split, mirroring the URL grouping:

| File | Approx LOC | Contents |
|---|---|---|
| `files/mod.rs` | ~50 | router + `FileEnvelope` + `AddStepResponse` + module re-exports |
| `files/upload.rs` | ~200 | `upload`, `list_all`, `get_summary`, `patch_file`, `delete_file` |
| `files/page.rs` | ~80 | `get_page`, `clear_filters` |
| `files/steps.rs` | ~200 | `add_step`, `cast_preview`, `undo`, `redo` |
| `files/joins.rs` | ~250 | `joins` (detect), `create_join` |
| `files/derive.rs` | ~250 | `snapshot`, `export`, `dedup`, `uniques`, `sentinels`, `compute_cleanness`, `clear_cleanness`, `set_encoding` |
| `files/hydrate.rs` | ~80 | `hydrate` (currently `pub(super)`; make `pub(crate)` so reports can keep importing it) |

Reports + dashboards stay single-file at 430 / 150 LOC — no need to split.

**Watch-out:** `hydrate` is imported from `routes::reports::run_saved` and `routes::reports::resolve_source_frame`. The visibility bump from `pub(super)` to `pub(crate)` is required when the file becomes a directory module.

### 5. Split [db.rs](backend/crates/api/src/db.rs) (~1620 LOC → 8-9 files)

Mirror the route modules: `db/{users,sessions,projects,files,steps,reports,dashboards,companies,sentinels}.rs`. Re-export from `db/mod.rs` so every existing `db::find_file(...)` call site stays unchanged. Pure code motion, zero behavioural risk.

Bonus: the per-resource files become natural homes for the row-mapping `FromRow` impls (`UserRow` → `UserProfile`, `FileRow` → `FileFull`, etc.) which today are scattered through `db.rs`.

---

## Tier 3 — Pattern cleanup (~½ day)

### 6. `require_owned` trait for detail-handler boilerplate

Every detail handler has the same two lines:

```rust
let user = super::resolve_user_rid(&state, &headers).await?;
super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
```

Repeated ~40 times across files / reports / dashboards / projects. Trait dispatch:

```rust
pub trait OwnedResource {
    const LABEL: &'static str;
    async fn owner(pool: &PgPool, rid: &str) -> sqlx::Result<Option<String>>;
}

pub struct File; pub struct Report; pub struct Dashboard; pub struct Project;
impl OwnedResource for File     { const LABEL: &'static str = "file";     /* ... */ }
// ...

pub async fn require_owned<R: OwnedResource>(
    state: &AppState, headers: &HeaderMap, rid: &str,
) -> Result<String, AppError> {
    let user = resolve_user_rid(state, headers).await?;
    ensure_owner(R::owner(&state.db, rid).await, &user, R::LABEL, rid)?;
    Ok(user)
}
```

Call site collapses to:

```rust
let user = require_owned::<File>(&state, &headers, &rid).await?;
```

~80 lines saved. Trait > macro because compile-time visible, no opaque expansion.

### 7. `Option<String>::sanitize()` for sparse-update bodies

The pattern `body.field.as_deref().map(str::trim).filter(|s| !s.is_empty())` shows up dozens of times in PATCH handlers (companies / users / files / reports / dashboards / me / projects). Tiny extension trait:

```rust
trait OptStrExt {
    fn sanitize(&self) -> Option<&str>;
}
impl OptStrExt for Option<String> {
    fn sanitize(&self) -> Option<&str> {
        self.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }
}
```

`body.display_name.sanitize()` reads cleanly. Pure cosmetic but the PATCH handlers get half as wide.

---

## Tier 4 — Dead-code + legacy cleanup

### 8. Decide on `data/src/render.rs`

It's a 2-line TODO stub but declared `pub mod render` in `lib.rs`, and REDMAP + cleaner-page docs claim `/api/docs` renders markdown via this module. The route doesn't exist. Three options:

- **Implement it.** Wire `pulldown-cmark` + `syntect` + `gray_matter` (already in workspace deps via the workspace.dependencies block — `maud = "0.26"`, `pulldown-cmark = "0.12"`, `syntect = "5"`, `gray_matter = "0.2"`). Adds the `/api/docs` route promised in REDMAP.
- **Delete it.** Drop `pub mod render;` from `lib.rs`, remove the unused deps from `Cargo.toml`, fix the docs that mention it. Saves compile time + removes a TODO.
- **Feature-gate it.** Wrap in `#[cfg(feature = "docs")]`; opt-in later.

Recommendation: **delete** unless `/api/docs` is on the near-term roadmap. The workspace currently compiles 4 unused crates (`maud`, `pulldown-cmark`, `syntect`, `gray_matter`) for a TODO.

### 9. Plan `PageQuery::{sort, dir}` deprecation

[`shared/src/file.rs:54-69`](backend/crates/shared/src/file.rs#L54-L69) carries both `sort + dir` (legacy single-key) and `sorts` (multi-key JSON). `parse::page` honours both with multi taking precedence ([parse.rs:288-295](backend/crates/data/src/parse.rs#L288-L295)).

The frontend's redtable now always sends `sorts` (the multi shape) per the cleaner page docs. Two steps:

1. Verify no saved spec / URL / bookmark relies on `sort + dir`. Grep frontend for explicit writes to those keys — should be zero.
2. Once verified, remove the fields from `PageQuery` and the fallback branch in `parse::page`. ~20 LOC.

Don't rush — the fallback costs nothing today.

### 10. `ChartSpec` flat-shape (defer — known)

[`shared/src/report.rs:147-214`](backend/crates/shared/src/report.rs#L147-L214) is the biggest single DTO at ~70 LOC, with 14 optional modifier fields that are kind-specific (`smooth` only applies to line/area; `donut`/`half`/`rose` only to pie; `regression` only to scatter; `symbol`/`symbol_repeat` only to pictorial_bar; `y_group_by` only to heatmap/radar; etc).

A tagged-union refactor (`enum ChartSpec { Bar(BarSpec), Pie(PieSpec), … }`) would be cleaner but breaks every saved spec in the DB. Not worth the migration churn at the current pace. **Defer.**

---

## Not worth doing

- **`PROJECT_SELECT` string fragment safety** ([db.rs:423-435](backend/crates/api/src/db.rs#L423-L435)) — `format!`-spliced WHERE clauses are static strings; theoretical risk only.
- **`crud!(reports)` macro** to auto-generate handlers — overkill, hard to read, locks the call shape.
- **Per-resource trait for `*_owner` lookups beyond #6's `OwnedResource`** — the SQL differs enough that a generic abstraction adds friction without removing real duplication.
- **Generic envelope cache** (`DashMap<rid, FileEntry>`) — only files use it. Premature.
- **Migration `CHECK (role IN (…))` duplication** — appears in `companies` + `project_memberships` (2 occurrences). A `CREATE TYPE role AS ENUM(…)` would unify but breaks the per-table enum (company roles ≠ project roles). Leave inline.
- **`apply_windows` / `apply_top_n` split in `group_by.rs`** — already well-factored into private helpers at the bottom of the file.

---

## Watch-outs

- **`From<sqlx::Error>` collapses the underlying error code into a string message.** The blanket impl preserves the message but you lose programmatic access to `DatabaseError::code()`. Keep #1 ALONGSIDE the existing UNIQUE-violation match arms (`23505 → username_taken / slug_taken`); don't replace them.

- **`blocking()` must preserve the JoinError vs DataError distinction.** A panicked closure (JoinError) maps to 500 "internal"; a DataError maps via its existing `From` impl (often 400 "invalid_csv"). Don't collapse to a single `?` over a generic `Result<T, Box<dyn Error>>` or the wire shape regresses.

- **Splitting `files.rs` and `db.rs` produces large diffs.** Pure code motion is zero-risk *behaviourally* but expensive in PR review noise + merge conflict risk on in-flight feature work. Schedule those when the page is quiet.

- **`require_owned::<R>` only fits the 4 owned resources** (file / report / dashboard / project). The companies path uses `require_member` ([companies.rs:50-59](backend/crates/api/src/routes/companies.rs#L50-L59)) which returns a role string — different shape, different gate. Leave it.

- **DTO field changes break cached envelopes** in the planned [localStorage cache](backend/suggestion-localstorage.md). Once Tier 1C of that doc ships, any rename in `shared/src/` needs a cache-version bump alongside. Document the convention before both land together.

- **The cleanness-recompute-on-every-hydrate** issue called out in [suggestion-localstorage.md](backend/suggestion-localstorage.md) Tier 0 is a candidate for a separate Rust-side fix: `hydrate` could skip the cleanness re-score when the only change is an `applied=true` flag toggle (undo/redo). Doesn't fit "factorisation" cleanly — it's a correctness/perf change — but worth flagging here so the same person planning these passes considers them together.

---

## Suggested phasing

| Phase | Work | Estimated win |
|---|---|---|
| **1** (½ day) | #1 + #3 (`From<sqlx::Error>` + AppError constructors) | -80 lines of `map_err`; handlers ~30% shorter; cleaner `?` flow |
| **2** (½ day) | #2 (`blocking()` helper) | -120 lines in files.rs alone; ceremonial spawn_blocking becomes one line |
| **3** (½ day) | #4 (files.rs split) | 1197-line file → 6-7 navigable submodules |
| **4** (½ day) | #5 (db.rs split) | 1620-line file → 8-9 navigable submodules mirroring routes |
| **5** (½ day) | #6 + #7 (OwnedResource trait + sanitize ext) | -80 lines across detail handlers + readability |
| **6** (½ day) | #8 (render.rs decision) + #9 (PageQuery deprecation audit) | Removes 4 unused deps OR ships `/api/docs`; one less legacy shape |
| **defer** | #10 ChartSpec tagged union | spec migration not worth the churn yet |

Phase 1 + 2 land in a single morning and the win is felt in any new handler immediately. Phase 3 + 4 are pure code motion (lots of diff lines, zero behavioural risk) — schedule when no feature work is mid-flight on those files.

The natural entry point for Phase 1 is one file (`crates/api/src/error.rs`) plus a search-and-replace pass over the call sites. Everything after builds on it.

---

## Handoff notes (2026-05-19)

This plan was written after a full read of the prerelease backend (api 36 files / 8.4k LOC, data 9 files / 2.6k LOC, shared 9 files / 0.7k LOC, 10 migrations / 0.3k LOC, `env-swap.sh`, `Cargo.toml`, `.env.example`). Three findings only surfaced on the oversight pass:

- **`data/src/render.rs` is a 2-line TODO stub** but declared `pub mod render` in `lib.rs`, and **4 unused workspace dependencies** are pinned for it: `maud = "0.26"`, `pulldown-cmark = "0.12"`, `syntect = "5"`, `gray_matter = "0.2"`. The REDMAP + cleaner-page docs claim `/api/docs` renders markdown via this module — no such route exists in `routes/mod.rs`. **Decision needed** before Phase 6: implement `/api/docs` (Tier 4 #8) or delete the stub + four deps.
- **`PageQuery::{sort, dir}`** legacy single-key fields are still honoured by `parse::page` as a fallback when `sorts` is absent (`parse.rs:288-295`). Frontend always sends multi-key `sorts` now per the cleaner page docs. Audit-then-drop in Phase 6 (Tier 4 #9).
- **`ChartSpec` is the biggest single DTO** (`shared/src/report.rs:147-214`, ~70 LOC) with 14 kind-specific optional modifiers. A tagged-union refactor would be cleaner but breaks every saved spec in the DB. **Deferred** (Tier 4 #10) — not worth the migration churn at current pace.

### Cross-doc note for the same agent

The cleanness-recompute-on-every-hydrate issue called out in [suggestion-localstorage.md](suggestion-localstorage.md) Tier 0 is a candidate for a separate Rust-side perf fix: `hydrate` could skip the cleanness re-score when the only change is an `applied=true` flag toggle (undo/redo). Doesn't fit "factorisation" cleanly — it's a correctness/perf change — but worth considering together since the same person is planning both passes.

### Phase 1 quick-start

When picking this up, the smallest viable opening move is:

1. Open `crates/api/src/error.rs`.
2. Add `impl From<sqlx::Error> for AppError { fn from(e) -> Self { Self::internal("db", e.to_string()) } }`.
3. Search-and-replace `.map_err(|e| AppError::internal("db", e.to_string()))?` → `?` across the api crate. Skip occurrences inside `match sqlx::Error::Database(...)` arms (UNIQUE-violation paths in `users.rs:70-72`, `companies.rs:172-174` need their explicit branches).
4. Run `cargo build -p api`. Should compile clean.
5. Run `cargo test --workspace`. Should pass unchanged.

That's the first ~½ day of Phase 1. The `AppError::db()/join()/io()` constructors (also Phase 1) and the `blocking()` helper (Phase 2) follow the same shape — small additions, mechanical replacement.

### What NOT to touch in the first passes

- Workspace `Cargo.toml` deps (unless implementing #8).
- Migration files (factorisation = code, not schema).
- The `shared` crate DTOs (renames break wire compatibility + invalidate cached envelopes from the planned localStorage cache).
- `id.rs` (it's already minimal).
- `bootstrap.rs` (idempotent + small).
- `health.rs` (27 lines, trivial).

These are stable boundaries — every refactor in this doc stays inside `crates/api/src/{error,db,routes/*,util}.rs` and (for #8) optionally `crates/data/src/render.rs` + workspace deps.
