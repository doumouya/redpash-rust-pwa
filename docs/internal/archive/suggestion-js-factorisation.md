---
title: JS / frontend refactor audit
section: Refactor
last modified date: 2026-05-22
superseded-by: tools/js-audit/ — recurring audit replaces the one-shot review
---

# JS / frontend refactor audit

Companion to `backend/suggestion-rust-factorisation.md`. **2026-05-22.**

Unlike the Rust backend — which survives and gets refactored — the
headline for the frontend is different: **most of it is already slated
for deletion.** The frontend is **26,617 LOC of JS** (47 files), 2.6×
the Rust backend, but the redtable migration replaces the Cleaner /
Reports / Dashboard / Objects pages wholesale.

So this audit is in three parts: what the migration **deletes** (don't
touch it), what is **dead now** (delete today), and the **survivors**
(the only place a traditional refactor applies). Structural refactors
only — correctness / security / perf bugs live in `fix-to-do.md`.

## Doomed — the migration deletes these

Refactoring them would be polishing a corpse — the migration *is* their
refactor, and it deletes them.

| File | LOC | |
|---|---|---|
| `pages/cleaner.js` | **8,653** | the single biggest file in RedPash |
| `pages/objects.js` | 3,999 | |
| `pages/reports.js` | 2,058 | |
| `reports/index.js` | 1,809 | the reports builder |
| `dashboards/*` (chart-render, index, widgets, echarts, templates) | ~1,660 | |
| `pages/dashboards.js` | 392 | |

**~18.6k LOC — 70% of the frontend JS — is doomed.** The prototype's
entire working Cleaner is a fraction of `cleaner.js`'s 8,653 lines:
that ratio is the migration's payoff, quantified.

## Dead now — delete today, independent of the migration

- **`scripts/cleaner/` — the whole directory** (`index.js`, `filters/`,
  `tools/*` — ~1,500 LOC). Not loaded by anything live; the Cleaner
  route runs `pages/cleaner.js`. Pure dead weight. (Also in `fix-to-do.md`.)
- **`scripts/redtable/schemas/` and `scripts/settings/` — empty
  directories.** Remove.
- **`redtable/index.js` (708)** — a well-built paged table, but its
  only importer is the dead `cleaner/index.js`, so it is **already
  orphaned**. The migration brings its own redtable; delete this one
  with the rewrite unless the port reuses parts.

## Dies with the migration

- **`controls.js` (1,929 LOC)** — loaded by `index.html`, so it *runs*,
  but every one of its ~40 `window.sp*` exports is consumed **only** by
  doomed surfaces (cleaner / objects partials + page scripts). Its one
  live touchpoint — `include.js:76` `spInit(root)` — becomes a no-op
  once those partials are gone. **Once the migration lands: delete the
  file, the `index.html` `<script>` tag, and the `spInit` call.** It
  installs 5 permanent `document`-level listeners — pure leak once
  dead. Its `OBJECT_TAB_CATALOG` is a stale duplicate of
  `objects-catalog.js` (still lists reports / dashboards).
- **`ui/pager.js`, `ui/history.js`** — import-orphaned once the doomed
  pages go (pager = the redtable pager used only by cleaner / objects /
  reports; history = the report / dashboard builders).

Net: the migration removes **~22k LOC** (the doomed 18.6k + the dead
`cleaner/` ~1.5k + `controls.js` + pager / history) — leaving roughly
**3.6k LOC** of surviving legacy JS, on top of the redtable's own
(much smaller) module set. That removal *is* the frontend refactor.

## Survivor refactor targets

The genuine audit — the ~3.6k that lives on: the shell (`main.js`,
`api.js`, `events.js`), the surviving pages (Home / Landing / Profile
/ Settings / Docs), `ui/{toast,modal}`.

### 1. Page lifecycle / teardown contract — highest value
There is **no `destroy` hook** between navigations. `main.js::mount`
does `app.innerHTML = html` and nothing else, so pages leak whatever
they attached. Confirmed: `settings.js:121` puts a `MutationObserver`
on `<html>` that **survives navigation permanently** — one new
observer per Settings visit; `redtable/index.js:536` leaks a
`document` click listener per mount; `main.js`'s topbar-menu listeners
orphan on re-render. Fix: `mount` returns a `cleanup` fn, called on the
next navigation — a small router change that closes a whole class of
leaks. (Overlaps the `fix-to-do.md` "no router unmount hook" item.)
Best done as part of the new shell, not bolted onto the old one.

### 2. One `esc()` — multiple copies
`escapeHtml` / `esc` is near-identically reimplemented across
`home.js`, `settings.js` (×2 — twice in one file), `landing.js`,
`redtable/index.js`. One `scripts/ui/esc.js` export collapses all of
them. The cheapest factor-to-the-atom win in the frontend.

### 3. Shared shell utilities — three more duplications
- **`doLogout`** — the same `POST /auth/logout` + redirect + reload in
  `home.js`, `profile.js`, `settings.js`, `docs.js`. One shell helper.
- **`animateNumber`** — byte-identical count-up easing in
  `home.js:445` and `profile.js:276`.
- **`fillAvatar` / initials** — avatar + initials logic in 4 places;
  `settings.js` and `docs.js`'s `fillAvatar` are almost verbatim.
  Parameterise: `fillAvatar(root, session, selector)`.

### 4. SWR paint pattern
The "cached → paint, fresh → repaint" triad recurs in `home.js`,
`profile.js::loadUsage`, `settings.js`. A `swr(paths, applyFn)` helper
would carry the pattern once.

### 5. `scoreClass` thresholds — was a divergent, latent bug
~~`file-review.js:202` and `home.js:380` both bucket a percentage into
hi / mid / lo — with **different thresholds** (90/70 vs 90/60).~~
Resolved as part of the file-review.js removal — `home.js`'s threshold
is now the single definition.

### 6. `main.js` — dead route machinery
`_matchPath` (246-258) supports `:param` patterns; **no route uses
them**. The `params` plumbing threaded `resolve → navigate → mount` is
unexercised — pages read query strings themselves. Delete it.

## Priority

| When | Items |
|---|---|
| **Now — independent of everything** | delete the dead `cleaner/` dir + the empty dirs · target 5 (`scoreClass` — a latent bug) |
| **With the migration** | "Dies with the migration" happens automatically as the doomed surfaces are removed — just don't forget the `controls.js` `<script>` tag + `spInit` call |
| **When the rewrite touches the router** | target 1 (teardown contract) — build it into the new shell |
| **Survivor cleanup, any time** | targets 2, 3, 4, 6, 7 — small, low-risk; do them as the surviving files are touched |

## Bottom line

The frontend's refactor story is not "factor these files" — it is
"**the migration deletes 70% of it, and ~1,500 lines are already
dead.**" An 8,653-line `cleaner.js` is the strongest argument for the
redtable rewrite that exists. The genuine traditional refactoring
surface — six small duplications and a missing teardown contract — is
modest, confined to the ~3.6k that survives, and none of it blocks the
migration.

— Gus
