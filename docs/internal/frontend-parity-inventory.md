---
title: Frontend parity inventory
section: Refactor
order: 1
last modified date: 2026-05-22
---

# Frontend parity inventory

> **Internal — `frontend-reset` rebuild checklist.** What each page does
> *today* + what's still missing to ship. `crossing-audit` verifies API
> wiring; this doc verifies *behavior*. Read alongside
> [`js-rust-boundary.md`](js-rust-boundary.md) and
> [`object-model-hard-refresh.md`](object-model-hard-refresh.md).

## Where we are

| | Old (prerelease, pre-reset) | After reset (2026-05-22) | After 2026-05-23 walk |
|---|---|---|---|
| HTML pages | 9 | 6 | **6** |
| JS LOC total | 26,617 | 1,498 | **1,529** |
| Distinct `/api` endpoints called | ~42 | 9 | **12** |
| Consolidated surfaces | — | `workspace` absorbs cleaner + objects + reports + dashboards | unchanged |
| CSS files | many | 14 | **15** (added `chart.css`) |

Routes: `/login`, `/home`, `/workspace`, `/profile`, `/settings`,
`/docs`. No more `/landing`, `/cleaner`, `/objects`, `/reports`,
`/dashboards` — they retired (some merged, some derived).

## Walk — 2026-05-23 (merge-readiness check)

Run by Woz against `frontend-reset`. Compared to the inventory as written 2026-05-22.

### Landed since 2026-05-22 ✓

- **Designer chart body (8th atom).** Commit `1aa8d3a`. `workspace.js` now detects `file_type === "chart"` files and renders them via ECharts into `#wsChart`; `chart.css` added as its own dedicated stylesheet. *Caveat:* renders **existing** charts (`GET /api/charts/:rid`) — does **not** yet build new ones. Chart-builder UI (type picker, axes/legend/tooltip/style accordion) is still open.
- **Workspace real-data wiring** (commit `c13d387`). Rail, file tabs, table all wired to live endpoints.
- **Observability endpoint:** `POST /api/events` — `events.js` ships frontend errors. New crossing.
- **Logout endpoint:** `POST /api/auth/logout` — new crossing (likely topbar).

### New gaps surfaced by the walk

- **Tools panel has 6 buttons but no JS handlers.** `partials/workspace.html:118-125` declares `.rt-tool-btn` × 6 (dedup, fill, fix, format-dates, split, trim). `workspace.js` does not attach any click handler. Clicking does nothing — no toast, no log, no feedback. Worse than empty, because it looks live. *Either* wire them to the planned `defineTool` factory, *or* add `disabled title="coming soon"` (the `wsNewProject` button shows the honest pattern).
- **Stale comment, rule-7 violation:** [`workspace.js:10-13`](../../frontend/scripts/pages/workspace.js#L10-L13) header says *"the refresh button"* is stubbed. The code at lines 576-586 actually re-fetches the open file. Fix the comment in the same commit as any other workspace touch.

### Cross-cutting — still open

- **Stage rename** (`import→new`, `report→design` per [hard-refresh D6](object-model-hard-refresh.md)). Backend phases 1+2 done; frontend untouched: [`home.js:11`](../../frontend/scripts/pages/home.js#L11) `STAGES = ["import","clean","report","publish"]` and [`workspace.js:18`](../../frontend/scripts/pages/workspace.js#L18) `STAGE_DOT` keys still use the old names. **Cheap visible fix.**
- **Boot splash** — not wired.
- **404 page** — still bare `<p>` at [`main.js:59`](../../frontend/scripts/main.js#L59).
- **"Real auth not fully wired"** — [`main.js:30`](../../frontend/scripts/main.js#L30) still has the dev-sentinel fallback.

### Per-page status delta

- **`/login`** — no change. Still complete.
- **`/home`** — no change. Still 2 small gaps (`href="#/workspace"` lacks rid, stage names old).
- **`/workspace`** — chart render ✓, real-data ✓. Still open: pagination + rows-per-page refetch, tools panel actions (now visibly broken — buttons without handlers), save edits/deletes, server-side filter/sort, file upload, history/steps log, chart **builder** UI, project CRUD, file metadata edit.
- **`/profile`** — no change. Still 25-LOC stub.
- **`/settings`** — no change. Still 27-LOC stub (theme only).
- **`/docs`** — no change. Still read-only index; viewer click-through not wired.

### Merge verdict

**Merge-ready as a reset, not as a parity rebuild.** The branch is internally clean — 1,529 LOC, 12 healthy crossings, no orphan CSS, no god-objects (assuming `audit.sh` stays green). Merging frontend-reset → prerelease *replaces* the old sprawl with a smaller cleaner base.

But it does **not** meet the original "merge at parity" contract this doc set: workspace is missing whole sub-features (tools, upload, history, chart builder, CRUD, metadata edit) and three pages are stubs. Those become prerelease TODOs after the merge.

**The honest framing:** this isn't a feature-equivalent swap — it's "trade the sprawling feature-rich frontend for a clean less-feature-rich one, and rebuild the missing surface on prerelease." Em's call whether the trade is worth taking now.

**Cheapest closeable-before-merge wins** (if you want to narrow the gap first):
1. Stage rename in `home.js` + `workspace.js` — 2 string edits.
2. Disable the unhanded tool buttons (`disabled title="coming soon"`) so they don't lie to the user — ~6 attributes.
3. Fix the stale workspace.js header comment — 1 line.

Three small edits, all under 30 minutes, and the merge is honest about its state.

## Cross-cutting gaps (apply across pages)

- **Stage rename.** [`home.js:11`](../../frontend/scripts/pages/home.js#L11) and [`workspace.js:18`](../../frontend/scripts/pages/workspace.js#L18) still use `["import", "clean", "report", "publish"]`. Per the [hard-refresh D6](object-model-hard-refresh.md), rename `import→new`, `report→design`.
- **Boot splash.** Not wired — [memory: `project_boot_splash_launch`] still pending (navigate-to-landing-before-loadSession is the fix).
- **404 page.** Bare `<p>` at [`main.js:59`](../../frontend/scripts/main.js#L59) — needs a real not-found surface.
- **"Real auth not fully wired"** — [`main.js:30`](../../frontend/scripts/main.js#L30) comment. `/api/me` 404 falls back to a `dev: true` sentinel; needs the real cookie/session path.
- **CSS:** `audit.sh`'s reachability check is now green (14/14 reachable). Hold it green — every new `.css` enters via a `<link>` in `index.html` or a traced `@import`, never a stray.

---

## `/login` — Sign-in + CSV demo · 96 LOC · **complete**

The product-first landing. Replaces the old `landing.js` (312 LOC) and absorbed its CSV demo.

**Surfaces**
- Pre-filled deliberately-messy CSV sample (quoted comma, multi-line cell, mixed dates, all-empty row) — the 101→178-row story, distilled.
- "Scan this CSV" button → live demo.
- Google sign-in button.
- On localhost: dev-login shortcut.

**Behaviors**
- POST `/api/demo/parse` with raw CSV body (`Content-Type: text/csv`, raw `fetch` — not `api.js` since the body isn't JSON).
- Renders `rows / columns / type_mismatches / empty_pct / parse_ms` + a colored cleanness score (`≥80 ok / ≥50 warn / else accent`).
- "Sign in with Google" → full-page redirect to `/api/auth/google/start`.
- Dev shortcut → POST `/api/auth/dev-login` → `#/home` + reload.

**Verdict:** parity with old landing's product-pitch + sign-in. No gap.

---

## `/home` — Project board · 81 LOC · **complete, 2 small gaps**

**Surfaces**
- Project count chip.
- Card grid: project name, optional `default` tag, 4-stage pipeline (`is-done / is-current / future`), meta line (file count · cleanness % · updated date).

**Behaviors**
- GET `/api/projects` → cards.
- Empty state ("No projects yet — upload a CSV to start").
- Error state with HTTP code.
- Each card links to `#/workspace`.

**Gaps**
- **Card href is `#/workspace`** with no `?project=<rid>` — workspace can't open the *clicked* project. Either pass the rid in the hash, or workspace honors a "last project" pref.
- **Stage names** still `import/clean/report/publish` (see cross-cutting).

---

## `/workspace` — The unified surface · 596 LOC · **core ✓ · several sub-features stubbed**

Replaces the old cleaner + objects + reports + dashboards. The biggest open page.

**Surfaces — already there**
- Rail (`#wsNav`): collapsible groups (one per project) with a colored 2-letter initial mark + file count.
- Group body: file tabs (`.rt-tab`) with stage dot, close button, type icon.
- Table (`#wsTable`): header row with sortable columns + a row-number column + a select column.
- Toolbar: row-search, refresh, row-number toggle, columns dropdown, rows-per-page dropdown, filter toggle, tools toggle, mode buttons (edit / select / delete).
- Filter panel (`#wsFilterPanel`): 2-level AND/OR predicate builder — group cards with `combo`, group separators showing the *outer* combo, 6 ops (`contains / is / not / starts / empty / filled`).
- Selection chip with count + clear-all.

**Behaviors — already wired**
- GET `/api/projects` → rail groups.
- Auto-expand the `is_default` group (or first); auto-load its files.
- On group expand: GET `/api/projects/:rid/files` (lazy, once).
- On default group load: auto-open the first file.
- On file tab click: GET `/api/files/:rid` + `/files/:rid/page` *in parallel*; reset all column-indexed state (sort, filter, search); render columns + first 25 rows.
- Tab close (visual remove — does not delete the file).
- Column-show/hide via the columns dropdown (CSS `display:none`, per `nth-child`).
- Search (over loaded rows, all-cell `.includes`).
- Sort: multi-key shift-click; date columns parse via `Date.parse`; sort badges with order index when >1 key.
- Filter (client-side over loaded rows): outer AND/OR over groups, group AND/OR over predicates, 6 ops.
- Select-all / row-checkbox sync, indeterminate state, selection chip.
- **Edit mode:** sets `contenteditable=true` on `.editable` cells. Enter commits + blurs.
- **Select mode + Delete:** click delete with rows selected → removes those rows from the DOM (visual).
- **Delete mode (no selection):** row-click removes the row (visual).
- Side panel toggles (filter, tools) with `.rt-panel-close`.
- Refresh button: re-fetches the open file (spinning icon).
- Dropdowns close on document click.

**Stubbed — explicitly TODO**
- **Pagination + rows-per-page refetch.** The dropdown only updates a *label* (`wsRowsLabel`). Needs the `/files/:rid/page?offset=&limit=` round-trip.
- **The cleaning tools panel.** The toggle opens `#wsToolsPanel` — but the actual 14+ tool actions (rename / cast / dedup / joins / drop_nulls / fill_nulls / filter_columns / split_column / change_case / snake_case / replace_in_names / replace_text / fix_invalid / encoding / format_dates / join_columns — old tools dir) aren't wired. Per [boundary doc](js-rust-boundary.md): each tool collects params into a `Step` DTO, server runs it (Tier-2 perf = `StepProgram` folded into one lazy plan).
- **Server-side filter / sort.** Today both are client-side over the loaded page only — the boundary contract says these compile to a Rust `Filter` AST (workspace.js:374-395 is JS predicate logic, the exact thing the boundary forbids long-term). Replace with: filter UI builds AST → POST `/api/files/:rid/page` body or query.
- **Save edits / deletes.** `setMode("edit")` lets you type; nothing PATCHes the server. `mode-delete` row removal is DOM-only. Needs PATCH `/api/files/:rid` or a step.
- **Refresh** also doesn't re-pull the project rail (only the open file). Minor.

**Not yet started — missing whole sub-features**
- **File upload** (drag-drop + picker, auto-clean pipeline). Was a centerpiece of the old cleaner.
- **History / step log** (`project_steps` — undo, jump-to-step).
- **Chart builder** (the old Reports page = "Designer"): chart type picker, axes / legend / tooltip / style accordion (per [`unified-surface.md`](../frontend/redpash-canary/unified-surface.md) + `red-front/designer.html`). ECharts render. POST `/api/charts`. The 8th atom per Torv's queue.
- **Dashboard view** (the old Dashboards page = "Publisher"): dashboard-files render, ECharts widgets.
- **Project CRUD** (create / rename / delete / archive — `?project=<rid>` URL handling).
- **File metadata edit** (rename, description) — distinct from cell content edits ([boundary doc](js-rust-boundary.md) seam ruling: metadata = plain PATCH, *not* a cleaning step).

**Retired by the object model — do NOT rebuild**
- Separate Reports page, separate Dashboards page, separate Objects page.
- `/api/reports` CRUD, `/api/dashboards` CRUD, `RPT_` / `DSH_` ids.

---

## `/profile` — Identity stub · 25 LOC

**There today:** initials avatar, display name, `@username` — all read from `session`.

**Gaps (the old profile was 287 LOC):**
- Edit display name / username.
- Password / account section.
- Plan / usage stats (where the Profile-side chart primitives land per [`project_reports_charts_reuse`] — usage sparkline, plan progress bar, sentinel histogram).

---

## `/settings` — Theme picker stub · 27 LOC

**There today:** 3-button theme picker (light / mocha / latte), syncs the `is-active` chip.

**Gaps (the old settings was 524 LOC, 29 prefs catalogued):**
- Density (compact / cozy / comfortable).
- File-handling defaults.
- Object-tabs ordering (per `objects-catalog.js` — now moot since Objects retired; replace with the workspace equivalent if any).
- Notifications / email.
- API key / dev settings.
- Full prefs grid that writes to `/api/users/:rid/prefs` (or wherever the server settles).

---

## `/docs` — Doc index stub · 62 LOC

**There today:** GET `/api/docs` → sections grouped by `it.section`, each row showing title + `last_modified`. Read-only.

**Gaps:**
- Click-through to a rendered doc body (the JS comment says "when the viewer does"). Server-side rendering exists at `routes/docs.rs` via `pulldown_cmark`; frontend needs the viewer surface.

---

## API endpoints the new frontend calls today

The full crossing surface (`crossing-audit` source of truth):

| Endpoint | Caller | Purpose |
|---|---|---|
| GET `/api/me` | `main.js:38` | Session load on boot |
| POST `/api/auth/google/start` (redirect) | `login.js:77` | OAuth start |
| POST `/api/auth/dev-login` | `login.js:84` | Dev shortcut |
| POST `/api/demo/parse` | `login.js:58` | CSV scan demo (auth:false, ephemeral) |
| GET `/api/projects` | `home.js:23`, `workspace.js:64` | Project list |
| GET `/api/projects/:rid/files` | `workspace.js:112` | Files per project |
| GET `/api/files/:rid` | `workspace.js:180` | File envelope (columns) |
| GET `/api/files/:rid/page` | `workspace.js:181` | First page of rows |
| GET `/api/docs` | `docs.js:17` | Docs index |

That's **9 endpoints**. The old frontend hit ~42 — the 33-endpoint gap *is* the work remaining (steps / upload / charts / prefs / metadata / history). Pages retired by the object model account for some of the 33; the rest is genuine rebuild surface.

## What "merge back at parity" means

The branch ships when:

1. **Every "stubbed — TODO" or "not yet started" item above is ✓ or explicitly retired** (with a one-line note here saying why).
2. **`crossing-audit` stays green** — every new endpoint has a Rust route + DTO.
3. **`audit.sh` stays green across all 5 audits** — no new god-object, no dup symbol regression, no orphan CSS, no dangling `/api`.
4. **The cross-cutting gaps** (stage rename, boot splash, 404 page, real auth) closed.

That's the contract. Anything not in this doc is out of scope for "parity"
— add it as a new line if it surfaces, don't smuggle it in.
