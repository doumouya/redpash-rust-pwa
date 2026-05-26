# Plan: localStorage for PWA speed

## What's there today

**Already in localStorage** (synchronous reads on boot):

- 9 user prefs mirrored via `PREFS_LS_MAP` (theme, top/bottom-bar position, bg palette, default delimiter/encoding/export-format, language, bg preview). Pattern: write-through to localStorage + PATCH `/me`, so shell paint never blocks on the network.
- Browser-global UI state: object-tab order, column widths, per-file "don't suggest X" skip sets, theme.

**Already in sessionStorage** (per-tab, dies on close):

- Cleaner + Reports mount-snapshot — chrome only, NO rows. Restored on hash match, overwritten per mount.

**Not cached anywhere** — refetched on every navigation:

- `/api/me` (incl. `global_sentinels`)
- All six list endpoints: `/api/projects`, `/api/files`, `/api/reports`, `/api/dashboards`, `/api/users`, `/api/companies`
- `/api/files/:rid` envelope (summary + columns + steps)
- `/api/files/:rid/page` rows
- `/api/projects/:rid/files`

Backend cost of a cache-miss (worth caching against): `hydrate()` does CSV decode + Polars parse + step replay + `data::dtype::summarize` (full `n_unique()` per column) + `data::stats::cleanness` (touches every string cell). That's hundreds of ms for any non-trivial file. The Rust DashMap hot-frame cache (`AppState.files`) helps within a process; localStorage is what makes the client feel fast across server restarts and cold mounts.

---

## Tier 0 — Free wins, no caching (couple hours)

### Z. Stop refetching after our own writes

Every mutating endpoint that returns a full envelope (`/steps`, `/undo`, `/redo`, `/cleanness`, `/clear-filters`, `/snapshot`, `/joins`) hands back `summary + columns + steps` already replayed. Today's sandbox `_afterHistory` (`cleaner.js:5378-5400`) mirrors that envelope into `STATE`, then calls `_paintSandboxTable` (`cleaner.js:6936-6939`), which fires a redundant `/api/files/:rid` round-trip in parallel with the necessary `/api/files/:rid/page` fetch.

**Fix**: extend `_paintSandboxTable` with an optional `{ envelope }` opt, same shape as `reports.js`'s `_paintReportsTable` already implements via its `needColumns` flag — clean in-tree precedent. When the caller passes an envelope, skip the `/files/:rid` GET; otherwise keep current behaviour for the cold paths (initial mount, tab switch).

**Apply to every `_afterHistory` caller** — not just undo/redo. The tool-dispatch path at `cleaner.js:5344`, `cleanerRefresh`, `cleanerScoreFile`, `cleanerClearFilters`, snapshot, `create_join`, and every tool-modal apply all land an envelope and benefit.

**Exception — `PATCH /files/:rid`** returns just `FileSummary`, not a full envelope. The envelope-in-hand branch is metadata-only there: header / summary can paint instantly, but columns + steps still need the GET. Don't blanket-skip on PATCH.

**Realistic win — ~50–150 ms saved per mutation.** Caveat: post-mutation, the POST handlers invalidate then re-populate the hot-frame cache before returning (`files.rs:411-414`), so the redundant GET hits a warm DashMap and only costs ~30–100 ms on localhost (lookup + one `list_steps` query). Tier 0 trims that plus a small amount of paint-blocking on the parallel `Promise.all`. Worth doing (zero downside, fewer races, enables the optimistic-paint variant below), but frame it as "shaves the redundant round-trip" rather than a dramatic 1.5 s → 400 ms.

If post-Apply *actually* feels like 1–2 s on a real file, the dominant cost is the cleanness recompute inside the POST's `hydrate` — a Rust-side fix (compute cleanness lazily, skip the recompute when the step is an `applied=true` toggle), not a frontend fix. Tier 0 is still worth shipping first because it's cheap.

**Optimistic-paint variant** — once the envelope-skip is in, this is essentially free: `_paintSandboxTable` currently `await`s `Promise.all([detail, page])` before painting anything, so the column-header repaint sits behind the slower of the two. Split it instead — resolve the envelope first (`Promise.resolve(envelope)` post-mutation), paint header + columns + "Loading rows…" in the tbody immediately, then `await pagePromise` and paint rows. Chrome flips in <50 ms; only the row paint waits.

No localStorage involved — the data already exists in the response we ignored.

---

## Tier 1 — High leverage, ~1 day

### A. SWR cache for list endpoints

Pattern: read cached JSON synchronously, paint immediately, refetch in parallel, overwrite on response. Targets the 6 list endpoints. Each is small (<30 KB even with 100s of items); the user perception is "Home / Reports / Cleaner appear instantly."

Helper shape — add to `scripts/api.js`:

```js
api.getCached("/files")  →  { cached, fresh }
```

Caller paints `cached` immediately, awaits `fresh` for the correction pass. Invalidation = overwrite on every successful fetch. No TTL needed.

**Budget**: ~5–10 KB per list × 6 = ~50 KB total.

### B. /api/me SWR

Same pattern, separately keyed (`rp-cache-me`). Kills the ~500 ms `global_sentinels` wait before the Cleaner's Fix-invalid modal becomes useful. Invalidate on `rpSavePref` (since prefs changed server-side).

### C. File envelope cache keyed by `summary.updated_at`

The cleaner/reports' first-paint-per-file pause is dominated by `hydrate()` on the server. Cache `{summary, columns, steps}` per file in localStorage; on file open, paint the columns and step history from cache while `/api/files/:rid` runs. When the live response's `updated_at` matches the cached one → no repaint. When different → repaint.

**Why `updated_at` keying works**: every state-changing endpoint bumps `updated_at` on the server, so a stale cache always loses a comparison.

**Budget**: ~3–5 KB per file. Cap at the 50 most-recently-touched files → ~250 KB.

---

## Tier 2 — Bigger wins, ~half day each

### D. Last-page-per-file row cache

Cache ONLY the last viewed page per file (one page, one toolbar state). Key: `(rid, updated_at, sorts_hash, search_hash, page, size)`. On reopen with matching state → paint instantly while live fetch runs.

**Why only the last page**: a 25-row default page is ~25 KB; full 50k-row caches won't fit. The sessionStorage doc's "Table contents NOT snapshotted" warning applies here too — bound it.

**Budget**: cap total row-cache at 1 MB → ~20 files × ~50 KB last-page each.

### E. Idle pre-warm

After mount completes, `requestIdleCallback` → refresh the other pages' list caches (`/api/dashboards` while you're on `/reports`, etc.). Cross-page navigation feels instant for the price of one idle round-trip.

---

## Tier 3 — Defer until measured

- **ETag / If-None-Match** on list endpoints — backend support needed. Worth it once lists grow.
- **IndexedDB** — when row caching ≥ a few MB and the 5–10 MB localStorage cap becomes binding. Async, basically unlimited. Not yet.
- **Schema-aware split** of columns vs rows in the page cache — added complexity without dramatic UI gain.

---

## Invalidation discipline

The sessionStorage mount-snapshot's existing rule works the same here:

- **Lists**: overwrite on every successful fetch. Done.
- **Envelope**: keyed by `updated_at`. Stale caches lose comparisons → no manual invalidation.
- **Rows**: keyed by `(rid, updated_at, toolbar-state-hash)`. Same — stale loses.
- **/api/me**: overwrite on fetch + on every `rpSavePref`.

What does NOT need manual invalidation: `POST /steps`, `/undo`, `/redo`, `/cleanness`, `/encoding`, `PATCH /files/:rid` — all bump `updated_at` server-side, so the next read sees a mismatch and repaints.

---

## Watch-outs

- **SW vs localStorage are separate layers**. SW caches HTTP responses (cacheFirst for shell, network-first for `/api`). localStorage caches parsed data. Pick one per resource. Today's SW is shell + API-network-first, so localStorage SWR on top is additive, not duplicative.
- **Per-origin, shared across tabs**. Two tabs writing the same key race. Today's prefs pattern tolerates "last write wins"; new caches inherit the same tolerance. The next fetch corrects.
- **`rpSavePref` writes localStorage SYNC, PATCHes `/me` ASYNC**. Mirror that pattern for cache writes: localStorage first (cheap), background fetch second.
- **Don't cache pages with `?q=…` or `?filters=…`** unless you key on them. Safest first cut: cache only the base page (no `q`, no filters) per file. Search/filter results bypass the cache.
- **Budget caps**. Total localStorage cap is 5–10 MB. The proposed Tier 1+2 budget is ~1.3 MB worst case (50 KB lists + 50 KB me + 250 KB envelopes + 1 MB rows). Plenty of headroom; add a soft byte-count check before each write to fail-fast if anything explodes.
- **PII** — solo dev / localhost today, but `/api/me` carries email + display name. If the multi-tenant story lands, decide whether to clear localStorage on logout (you probably should — easy to add to the `/auth/logout` path).
- **Schema migrations**: if a DTO field changes name (renames in `shared/src/`), cached entries deserialize wrong. Mitigation: version every cache key (`rp-cache-v1-files-list`); bump `v` on breaking shape changes — same idea as the SW `CACHE_VERSION`.

---

## Suggested phasing

| Phase | Work | Estimated win |
|-------|------|---------------|
| **0** (couple hours) | Tier 0 Z: skip `/files/:rid` refetch when `_afterHistory` already has a fresh envelope (mirror `reports.js`'s `needColumns` pattern). Layer on optimistic header/columns paint while `/page` lands. | Shaves a warm-cache GET (~50–150 ms) per mutation + lets chrome paint in <50 ms via the optimistic variant. No caching infra needed. If real post-Apply latency feels >1 s, the bottleneck is `hydrate`'s cleanness recompute (Rust-side, separate fix). |
| **1** (1 day) | Tier 1 A + B + C: cache helper + 6 list SWR + me SWR + envelope cache keyed on `updated_at`. Wire into home / reports / cleaner / objects / profile mounts. | Cross-page navigation < 50 ms first paint vs today's ~300–500 ms. |
| **2** (½ day) | Tier 2 D: last-page row cache for cleaner + reports. | File-reopen feels instant; eliminates the "Loading…" flash on tab switches. |
| **3** (½ day) | Tier 2 E: idle pre-warm. | "Already loaded" feel when navigating between Home / Reports / Dashboards. |
| **defer** | Tier 3 (ETag, IndexedDB, schema-aware splits) | Bigger but only worth doing once you've measured 0–D and know what's binding. |

When you want to start, the natural entry point for Phase 1+ is one helper in `scripts/api.js`:

```js
api.getCached(path, { key, ttl?, version? })  →  { cached, fresh }
```

Everything else (envelope, rows, me) is a thin wrapper that adds a custom key derivation (`(rid, updated_at)` etc.) on top.

Phase 0 ships independently — it's a `_afterHistory` edit, not an `api.js` edit.

---

## Review notes (2026-05-19)

Verified against the prerelease codebase. Tier 0 is real and worth doing; calibration and implementation details below.

### Verified

- `_paintSandboxTable` at `cleaner.js:6936-6939` always runs both `/files/:rid` and `/files/:rid/page` in parallel.
- `_afterHistory` at `cleaner.js:5378-5400` receives the envelope from the POST, mirrors it into `STATE`, then calls `_paintSandboxTable` — which refetches what it just stored. Confirmed redundant.
- Every POST that flows through `_afterHistory` triggers the same redundant GET: `/undo`, `/redo`, `/steps`, `/clear-filters`, `/cleanness`, `/snapshot`, `/joins`, and the every-tool dispatch at `cleaner.js:5344`.

### In-tree precedent

`scripts/pages/reports.js`'s `_paintReportsTable` already implements the envelope-skip via a `needColumns` flag (`STATE.columns.length === 0`). Mirror the same shape into cleaner: `_paintSandboxTable(root, activeFile, opts?: { envelope })`. When `envelope` is provided, skip the `/files/:rid` GET; otherwise current behaviour.

### Calibration — the "~1.5 s → ~400 ms" estimate is likely overstated

Post-mutation, the POST handlers invalidate then re-populate the hot-frame cache before returning (`files.rs:411-414`). The redundant GET hits a warm DashMap entry → fast (~30–100 ms on localhost: lookup + one `list_steps` query). Real Apply-latency budget:

- POST step (apply + replay + cleanness recompute): variable, often dominant
- Redundant GET `/files/:rid` (warm cache): ~30–100 ms ← what Tier 0 saves
- Page fetch: 50–200 ms

Tier 0 saves ~50–150 ms in the typical case. Worth doing (zero downside, fewer races, enables optimistic chrome paint), but the framing should be "shaves the redundant round-trip" rather than "1.5 s → 400 ms." If post-Apply *actually* feels like 1–2 s, the dominant cost is the cleanness recompute inside the POST's `hydrate` — a Rust-side fix (compute cleanness lazily, skip on `applied=true` toggle), not a frontend fix.

---

## Shipped (2026-05-19)

Phases 0, 1, and 2 D + 2 E all landed in a single session (SW v418 → v492). Tier 3 (ETag / IndexedDB / schema-aware split) deferred per the original plan.

### Tier 0 — envelope-skip ✅
`_paintSandboxTable(root, activeFile, opts = {})` accepts an `opts.envelope` so callers that already hold a fresh `FileEnvelope` skip the redundant `/files/:rid` GET. `_afterHistory` passes the POST response straight through.
- [cleaner.js `_paintSandboxTable`](frontend/scripts/pages/cleaner.js) — `opts.envelope` short-circuit
- [cleaner.js `_afterHistory`](frontend/scripts/pages/cleaner.js) — `{ envelope }` pass-through

### Tier 1 A — list SWR helper + 6 wirings ✅
`api.getCached(path, opts?) → { cached, fresh }` + `api.invalidateCached(path, opts?)` in `scripts/api.js`. Wired into:
- home.js mount (projects / reports / dashboards) — Promise.all parallel paint
- profile.js mount (`/me`) + `loadUsage` (3 lists)
- objects.js SCHEMAS registry — added `path:` field, refactored `loadTable` + `_objLoadAndPaint` to read SWR
- reports.js mount (`/files` source picker)
- dashboards/index.js `showList` (extracted `_paintDashboardsList` + re-attachable handlers) + helper write-throughs
- cleaner.js mount — write-through on `/projects` + `/projects/:rid/files` (read-side deferred since sessionStorage mount-snapshot already covers intra-session paint)

### Tier 1 B — `/me` SWR + invalidation ✅
- `main.js loadSession` reads `/me` via SWR + applies cached prefs synchronously
- `settings.js` + `profile.js` mounts SWR-paint `/me`
- Every `PATCH /me` (rpSavePref, settings save, profile save) calls `api.invalidateCached("/me")` so the next `loadSession` re-fetches a full `MeResponse` (PATCH returns just `UserProfile`, can't blanket-overwrite the cache)

### Tier 1 C — per-file envelope cache by `updated_at` ✅
- `_readFileEnvelope` / `_writeFileEnvelope` / `_clearFileEnvelope` + LRU index in cleaner.js, capped at 50 entries
- `_paintCachedTableShell` paints header + column shell + "Loading rows…" placeholder from cache
- 3-way paint decision: both caches match `updated_at` → no DOM update at all; only env matches → tbody-only swap; differs / cold → full repaint
- File-delete paths (`_ovDeleteOne`, `cleanerOvBulkDelete`) call `_clearFileEnvelope` so the LRU doesn't keep tombstones

### Tier 2 D — last-page row cache ✅
- `_readPageCache` / `_writePageCache` / `_clearPageCacheForRid` + LRU index, capped at 1 MB total bytes (size-aware eviction)
- Cache key: `rp-cache-v1-page::<rid>::<updated_at>::<sorts>::<q>::<page>::<size>`
- `_buildSandboxTbody` extracted so both early (cached) and main (fresh) paints produce identical row markup
- Cold-path early paint pulls cached rows into the shell when env + page caches both hit; updated_at match → zero DOM update on the post-fresh paint

### Tier 2 E — idle pre-warm ✅
`api.prewarm(paths, opts?)` uses `requestIdleCallback` with `setTimeout` fallback. Wired into:
- home.js mount → prewarm `/files`, `/users`, `/companies`
- profile.js mount → prewarm `/files`, `/users`, `/companies`
- settings.js mount → prewarm 6 lists
- reports.js mount → prewarm `/projects`, `/reports`, `/dashboards`, `/users`, `/companies`
- objects.js mount → prewarm every non-active SCHEMA path
- dashboards/index.js → prewarm 5 lists
- cleaner.js mountSandbox → prewarm `/files`, `/reports`, `/dashboards`, `/users`, `/companies`

### Gotcha recovered

Duplicate `function _pageCacheKey` declaration (line 404 legacy + new Tier 2 D helper) is a parse-time `SyntaxError` in ES modules (strict mode), not a runtime error — blanked the entire Cleaner page until the new helper was renamed to `_pageRowsCacheKey`. Captured in feedback memory (grep for symbol names before adding module-scope helpers).

### Net result

- 400k-row file at 5k-rows-per-page: <1 s initial load, sub-100 ms tab switches
- Cross-page nav paints from cache + idle pre-warm makes every other page feel "already loaded"
- Every mutating endpoint that returns a `FileEnvelope` benefits (Tier 0): `/steps`, `/undo`, `/redo`, `/cleanness`, `/clear-filters`, `/snapshot`, `/joins`, and the every-tool dispatch

### Implementation notes

- **Apply to every `_afterHistory` caller** — not just undo/redo. The every-tool dispatch at `cleaner.js:5344` also benefits, as do `cleanerRefresh`, `cleanerScoreFile`, `cleanerClearFilters`, `create_join`, snapshot, and every tool-modal apply path that lands an envelope.
- **`PATCH /files/:rid` is the asymmetric case.** It returns just `FileSummary`, not `FileEnvelope`. The "envelope in hand" branch is metadata-only — header/summary can paint instantly, but columns + steps still need the GET. Don't try to skip the GET on PATCH or you'll end up with stale columns.
- **Optimistic chrome paint variant** (in the original doc): today the column-header repaint sits behind `Promise.all`, so even though the fetches are parallel, the paint is sequential. The variant splits it — `await envelopePromise` first, paint header + columns + "Loading rows…" in the tbody, then `await pagePromise`, paint rows. With Tier 0's envelope-skip the envelopePromise is `Promise.resolve(envelope)` post-mutation, so this becomes essentially free.
