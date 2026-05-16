# RedPash — Fix To-Do

Generated from code review on 2026-05-14. Grouped by severity.

## Must-fix — correctness (broken today)

- [ ] **`history.replaceState` shadowing** — `frontend/scripts/reports/index.js:1166` and `frontend/scripts/dashboards/index.js:475`. Local `history` from `createHistory()` shadows `window.history`; `history.replaceState(...)` throws on every report/dashboard save (toast never fires, URL never syncs, reload creates duplicates). Fix: call `window.history.replaceState` or rename the imported instance.
- [ ] **Unguarded `res.items`** — `frontend/scripts/pages/home.js:473` (and `showList`/`loadSourceFiles`/`renderStep1Cards`/`dashboards` `loadProjectReports`). `api.get` returns `null` on 204/empty → `TypeError` crashes the home mount. Fix: `res?.items ?? []` everywhere, or have `api` return `{}` instead of `null`.

## Critical — security / operational

- [ ] **Dev-user fallback in prod** — `backend/crates/api/src/routes/me.rs:86`, `backend/crates/api/src/state.rs:84`. If a prod deploy boots without all 3 `GOOGLE_OAUTH_*` vars, every request silently resolves to one shared unauthenticated account (only an `info!` log). Fix: require explicit `REDPASH_ALLOW_DEV_USER=1` opt-in, or refuse to boot when OAuth is unconfigured.
- [ ] **`CorsLayer::permissive()` in prod** — `backend/crates/api/src/routes/mod.rs:89`. Ships wide-open despite a comment claiming env-tightened. Fix: read an origin allowlist from env, lock down the default.
- [ ] **Session cookie not `Secure`** — `backend/crates/api/src/routes/auth.rs:207`. Flag omitted with a "flip on later" comment. Fix: drive from env (`REDPASH_SECURE_COOKIES`), default on.
- [ ] **Unbounded in-memory frame cache** — `backend/crates/api/src/state.rs:48`. No eviction/LRU/cap; joins endpoint (`backend/crates/api/src/routes/files.rs:457`) hydrates every other file in the project serially → one GET can OOM the server. Fix: bounded LRU (e.g. `moka`) + cap join candidate count + parallelize with bounded concurrency.

## High

- [ ] **No router unmount hook** — `frontend/scripts/main.js`. Every page leaks `document` listeners, a `MutationObserver` (`frontend/scripts/pages/profile.js:133`), timers, and ~40 `window.*` globals per navigation. Add a teardown contract to the route table.
- [ ] **Redtable leaks `document` click listener per mount** — `frontend/scripts/redtable/index.js:536`. `destroy()` (line 667) only clears innerHTML. Fix: keep a handle, remove it in `destroy()`, also `clearTimeout(searchDebounce)`.
- [ ] **~1,500 lines of dead code** — `frontend/scripts/cleaner/index.js` + all of `frontend/scripts/cleaner/tools/`. Never loaded; live route uses `pages/cleaner.js`. Delete (move `filters/` up a level) or document why kept.
- [ ] **Service worker** — `frontend/service-worker.js`. `cacheFirst` discards the revalidate fetch (stale JS forever despite the "stale-while-revalidate" comment); `SHELL_ASSETS` precaches almost nothing → most offline routes return a 503 that `import()` can't parse → blank page. Fix: real stale-while-revalidate, expand precache list.
- [ ] **No per-file locking** — `backend/crates/api/src/routes/files.rs:298`. Concurrent `add_step`/`undo`/`redo` on one file interleave (ordinals, redo-stack, cache state). Fix: per-RID async mutex around mutate-then-rehydrate.
- [ ] **DB write amplification on read path** — `backend/crates/api/src/routes/files.rs:812`. `update_file_columns` writes on every hydrate, i.e. every paginated read. Fix: move the write to step apply/undo/redo only.
- [ ] **Upload memory blowup** — `backend/crates/api/src/routes/files.rs:175`. 256 MiB upload held ~3-4× resident; no upload concurrency limit → 8 concurrent uploads can OOM. Fix: stream to disk then parse from file; add an upload semaphore.
- [ ] **Row-delete with active search deletes wrong row** — `frontend/scripts/pages/cleaner.js:1510`. Uses page-relative→absolute index math, ignores server `row_indices`. Fix: read `row_indices` from the `/page` response like `redtable/index.js:204` does.

## Medium

- [ ] **TLD hint silently discarded** — `backend/crates/data/src/encoding.rs:20`. `.and_then(|_| None)` makes the TLD expression always `None`; plumbed-through feature does nothing.
- [ ] **`ensure_named_project` TOCTOU race** — `backend/crates/api/src/db.rs:300`. No transaction, no unique constraint on `(owner_id, name)` → duplicate projects on concurrent uploads. Fix: `INSERT ... ON CONFLICT` or add unique index.
- [ ] **Swallowed errors** — `let _ = delete_session` (`backend/crates/api/src/routes/auth.rs:198`) makes logout "succeed" even if the row survives; `serde_json` `unwrap_or_default()` calls in `db.rs` turn corrupt JSONB into empty results with no error. Fix: log/surface failures.
- [ ] **`render.rs` stub with heavy deps** — 2-line TODO stub but `lib.rs` + Cargo pull pulldown-cmark/syntect/gray_matter/maud as if functional. Fix: drop deps until implemented, or implement.
- [ ] **`Content-Disposition` filename sanitization incomplete** — `backend/crates/api/src/routes/files.rs:721`. Doesn't strip `;` or non-ASCII. Fix: RFC 5987 `filename*=UTF-8''...` form.
- [ ] **`column_count` vs `col_count` typo** — `frontend/scripts/pages/cleaner.js:1548`. Overview card always shows 0 columns. Fix: use `col_count`.
- [ ] **`api.js` 401 handler redirects AND throws** — `frontend/scripts/api.js:39`. Callers double-handle (render error into a page about to be torn down). Fix: pick redirect-and-swallow or throw-and-let-router-handle.
- [ ] **`create_session` binds interval as string** — `backend/crates/api/src/db.rs:204`. Parameterized (not injectable) but fragile. Fix: `make_interval(days => $3)` with i32 bind, or compute `expires_at` in Rust.
- [ ] **`dedup::detect` materializes all duplicates before truncating** — `backend/crates/data/src/dedup.rs:64`. Allocates whole frame as strings on mostly-duplicate files. Fix: compute counts from mask, stringify only the capped subset.
- [ ] **`joins` endpoint serial full-CSV parses** — `backend/crates/api/src/routes/files.rs:457`. (Tied to the unbounded-cache critical item.)
- [ ] **`xlsx_to_csv` silently drops sheets 2..N** — `backend/crates/data/src/parse.rs:47`. Fix: surface a notice in the upload response.
- [ ] **`docs.js` injects server HTML via innerHTML, no `res.ok` check** — `frontend/scripts/pages/docs.js:70`. Safe only if cmark sanitizes raw HTML and docs are trusted. Fix: confirm cmark config, add `res.ok` check, add a comment.

## Low / nits

- [ ] CDN deps with no SRI / not precached — ECharts (`frontend/scripts/dashboards/echarts.js`), bootstrap-icons (`partials/cleaner.html`). Breaks offline claim.
- [ ] Theme-color meta is leftover Catppuccin blue (`#4f8ef7`) not brand red (`#b3001b`) — `frontend/scripts/main.js:339`.
- [ ] Accessibility — redtable sort headers are non-keyboard `<th>` click handlers; draggable column reorder has no keyboard path; `partials/cleaner.html` has 136 inline handlers, 24 aria attrs.
- [ ] `toast.js` — no cap / de-dup on concurrent toasts; failing loops stack dozens.
- [ ] `ui/modal.js` appears to be dead code (nothing live imports it); name collides with `window.openModal` in `main.js`.
- [ ] Auth re-resolved on every request — 2 DB round-trips before any work. Consider a short-TTL session cache.
- [ ] `count_cell_diffs` (`backend/crates/data/src/stats.rs:20`) is O(rows×cols) with per-cell stringification, run synchronously after every step just for a toast metric. Make optional/sampled.
- [ ] `MAX_UPLOAD_BYTES` / `MAX_BODY_BYTES` defined twice; `mod.rs:9` doc says "64 MiB", constant is 256 — doc/code drift.
- [ ] `group_by.rs:218` — `Mean`/`Min`/`Max`/`First` on `col:"*"` silently return `1` instead of erroring.
- [ ] `health.rs` — promised `?deep=1` Postgres ping not implemented; health check can't detect a dead DB.
- [ ] Reports `runPreview` builds the identical body object 3 times (`frontend/scripts/reports/index.js:1113,1135,1287`) — extract a builder.
- [ ] `_resetFileReviewModal` hard-codes SVG dasharray magic numbers duplicated from the library (`frontend/scripts/pages/cleaner.js:251`).
- [ ] `reports/index.js` & `dashboards/index.js` register never-removed `keydown` listeners (lines 1267 / 418).
- [ ] `home.js:175` reads `res.summary.redpash_id` unguarded while `homeUploadConfirm:316` correctly uses `?.` — inconsistent.

## Documentation drift

Found while reading the full `docs/` tree — internal contradictions, not code bugs.

- [ ] **`/api/docs` documented as both wired and not wired** — `docs/api/overview.md` says the route "isn't wired yet" (ServeDir fallback; `render.rs` is a stub), but `docs/INDEX.md`, `docs/REDMAP.md`, and the REDMAP API quick-reference list `GET /api/docs` / `GET /api/docs/:slug` as real endpoints. Code review confirmed `render.rs` is a 2-line stub. Pick one source of truth.
- [ ] **Step kinds disagree across docs** — `docs/REDMAP.md`, `docs/db/schema.md`, and `docs/api/files.md` list 8 kinds (`drop_columns`, `rename_column`, `drop_rows`, `drop_nulls`, `fill_nulls`, `change_case`, `replace_text`, `fix_invalid`). `docs/objects/file.md` lists a different 16-kind set (`drop_duplicates`, `cast`, `snake_case`, `split_column`, `join_columns`, `format_dates`, …). Reconcile against `data/src/steps.rs::replay`.
- [ ] **`docs/frontend/chrome-device-dimensions.md` is an orphan** — copy-pasted public gist about Chrome DevTools device emulation; no frontmatter, not linked from `INDEX.md`, unrelated to RedPash. Remove or relocate.
- [ ] **Phase 3 status inconsistent** — "Shipped" (`VISION.md`) vs "Mostly shipped" (`getting-started.md`) vs shipped (`REDMAP.md`). Minor; pick one.
- [ ] **Chart-kind count inconsistent** — `REDMAP.md` says "~12 chart kinds"; `VISION.md` / `features/charts.md` / `objects/chart.md` say 13.

## Notes

- No SQL injection found (parameterized throughout). No XSS found (consistent `esc`/`_escHtml` on `innerHTML`).
- `render.rs` and missing `POST /projects` are honestly-labeled unfinished work, not bugs.
- Docs note `Secure`-cookie-off-in-dev and the `CorsLayer::permissive()` TODO — both line up with the Critical security items above.
