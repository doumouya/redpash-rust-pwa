# All CSS in the RedPash project — internalization plan

Move every CSS file the app currently pulls from the external
`redpash-components/` library into `redpash-app/frontend/styles/`, so the
app has **zero `/vendor/` imports**.

**Why this is worth doing**
- `redpash-components/` is **not a git repo** — every edit there (the whole
  file-tabs / tools-panel / pager cleanup) is invisible to version control.
  Internalizing puts all CSS under `redpash-app` git.
- The app is the library's **only consumer** (the sandbox `redpash-front-end/`
  has its own monolithic `main.css`). The "shared library" model isn't
  actually shared — so internalizing loses nothing real.
- One less moving part: no `ServeDir` mount, no path indirection, no
  sandbox-vs-vendor drift.

---

## Status — 2026-05-20

**Done & committed:** Phase 0 (prep), Phase 1 (foundation → `styles/base/`),
Phase 2a (redtable family → `styles/components/redtable/`), Phase 2b
(overlays + controls), Phase 2c (home/profile family) — 2b/2c →
`styles/components/`. See `git log` for commit hashes. Pages verified clean
(cold reload, SW unregistered) after each phase.

> ⚠️ **After each phase — eyeball the affected pages** (hard-refresh, clean
> SW). The migration is behaviour-neutral by construction — byte-identical
> copies, same `@import` order — but a moved-file typo would show as a 404.
> Next to verify: Home / Profile after 2c, Landing after 2d.

**Remaining:** Phase 2d (landing/marketing — 6 files: hero, hero-steps,
cta-btn, eyebrow, bottom-nav, rotate-prompt), Phase 4 (JS + cut the
`/vendor` mount), Phase 5 (verify + `/vendor` comment sweep). This migration
is housekeeping — resume it deliberately; don't let it crowd out actual
product work.

---

## Current state (inventory)

### `frontend/styles/` today
```
styles/
  main.css                       — global entry
  components/                    — app-owned components (7 files)
    buttons.css  topbar.css  toast.css  modal.css  filters.css  forms.css
    redtable.css                 — ORPHAN (imported by nobody)
  pages/                         — per-route CSS
    cleaner.css objects.css reports.css dashboards.css profile.css
    home.css landing.css
    dashboards.live.css profile.live.css reports.live.css   — DEAD backups
```

### What's pulled from `/vendor/redpash-components/`
- **Root:** `tokens.css`, `reset.css`, `shell.css` (3)
- **`components/`:** 38 files actually imported — `typography, button, form,
  card, modal, auth-modals, redtable, redtable-pro, pager, proj-tabs,
  file-tabs, dropdowns-sandbox, filter-panel-sandbox, tools-panel-sandbox,
  objects-sandbox, theme-toggle, float-btn, badge, tool-modal, filter-by,
  col-order, file-review, glass-btn, modals-sandbox, backgrounds, avatar,
  page-dots, home-screen, minitable, stat-strip, upload-zone, settings-card,
  hero, hero-steps, cta-btn, eyebrow, rotate-prompt, bottom-nav`
- **1 JS file:** `js/file-review.js` (`index.html:86`) — the only non-CSS
  `/vendor/` reference.

**Total to internalize: 41 CSS files + 1 JS file.**

### Do NOT migrate (dead — imported by nothing)
`carousel.css`, `gradients.css`, `help-content.css`, `progress.css`,
`tokens-gradient.css`. Plus `side-panel-tabs.css` — currently orphaned by
the ditched Reports rebuild; migrate it only if/when Reports is rebuilt.

### Key facts that make this safe
- Vendor CSS files have **no internal `@import`s** — every file is flat and
  self-contained. Copying a file + repointing its importers is a pure
  no-op for rendering.
- The migration unit is therefore one file: **copy byte-identical →
  repoint `@import`s → done.** Zero visual change per file.

### Collisions to resolve
| File | App copy | Vendor copy | Resolution |
|---|---|---|---|
| `redtable.css` | `styles/components/redtable.css` — **orphan, dead** | imported by 5 pages | Delete the orphan, then the vendor file lands cleanly |
| `modal.css` | `styles/components/modal.css` — imported by `main.css` | imported by most pages | Different concerns (`.rp-modal` library vs app modal) — rename the incoming vendor file (e.g. `modal-sandbox.css`) to avoid the clash; reconcile later |
| `button(s)` / `form(s)` | `buttons.css`, `forms.css`, `filters.css` (app) | `button.css`, `form.css`, `filter-by.css` | No filename clash (plural vs singular). Leave both; audit for true overlap in Phase 3 |

---

## Q1 — Proposed `frontend/styles/` structure

```
styles/
  main.css                     — global entry; imports base/ + global components

  base/                        — foundation layer, loaded first
    tokens.css
    reset.css
    typography.css
    backgrounds.css
    shell.css

  components/                  — reusable UI components (flat)
    button.css  glass-btn.css  form.css  card.css  badge.css
    modal.css  modal-sandbox.css  auth-modals.css  modals-sandbox.css
    theme-toggle.css  float-btn.css  avatar.css  toast.css  topbar.css
    cta-btn.css  hero.css  hero-steps.css  eyebrow.css  bottom-nav.css
    rotate-prompt.css  page-dots.css  home-screen.css  minitable.css
    stat-strip.css  upload-zone.css  file-review.css  settings-card.css
    filters.css  forms.css  buttons.css        — existing app components

    redtable/                  — the redtable subsystem (cohesive, ~13 files)
      redtable.css  redtable-pro.css  pager.css  proj-tabs.css  file-tabs.css
      filter-panel-sandbox.css  tools-panel-sandbox.css  side-panel-tabs.css
      dropdowns-sandbox.css  col-order.css  filter-by.css  objects-sandbox.css
      tool-modal.css

  pages/                       — per-route CSS (unchanged location)
    cleaner.css  objects.css  reports.css  dashboards.css
    profile.css  home.css  landing.css
```

**Rationale**
- **`base/`** — tokens / reset / typography / backgrounds / shell are the
  foundation every page sits on. Grouping them makes the load order
  obvious (`main.css` imports `base/` first, always).
- **`components/` flat** — most components are independent; a flat folder
  is the easiest to scan. ~28 files is fine flat.
- **`components/redtable/` subfolder** — the redtable family is large (~13
  files) and tightly coupled (it's the subsystem the recent dedup work
  touched). A subfolder keeps it from drowning the flat list. *Optional —
  flat works too if you prefer no nesting.*
- **`pages/` unchanged** — already correct; just delete the dead
  `*.live.css` backups.
- **Naming** — drop the `-sandbox` suffix over time (`dropdowns-sandbox`,
  `modals-sandbox`, `filter-panel-sandbox`, `tools-panel-sandbox`,
  `objects-sandbox`) — it's a historical artifact, not meaningful once the
  files live in the app. Rename lazily, not as a blocker.

---

## Q2 — Incremental merge plan

**Guiding rule:** every step is behavior-neutral. Copy files byte-identical,
keep `@import` order identical, migrate in small committed batches, smoke-test
after each. `redpash-components/` stays on disk untouched until the very end
as a safety net.

### Phase 0 — Prep
- [ ] Create `styles/base/` and `styles/components/redtable/`.
- [ ] Delete the orphan `styles/components/redtable.css` (confirm: no
      `@import` references it).
- [ ] Delete the dead `styles/pages/*.live.css` (and the matching
      `partials/*.live.html`) — they only carry stale `/vendor/` imports.
- [ ] Decide the `modal.css` rename (recommend incoming vendor →
      `modal-sandbox.css`).

### Phase 1 — Foundation (`base/`)
- [ ] Copy `tokens.css`, `reset.css`, `shell.css` (root) + `typography.css`,
      `backgrounds.css` (`components/`) → `styles/base/`.
- [ ] Repoint `main.css` (`tokens`, `reset`, `backgrounds`) and the importers
      of `typography` / `shell` → `/styles/base/…`.
- [ ] SW `CACHE_VERSION` bump. Hard-refresh **every** page — this layer is
      global; verify nothing shifts.
- [ ] Commit: `css: internalize foundation layer (base/)`.

### Phase 2 — Components, in cohesive batches
For each batch: copy the files into `styles/components/[redtable/]`,
repoint every matching `@import` across `main.css` + page CSS, SW bump,
smoke-test the affected pages, commit.

- [ ] **2a — redtable family** → `components/redtable/`. Affects
      cleaner / objects / reports / home.
- [ ] **2b — overlays + controls**: `modal(-sandbox)`, `modals-sandbox`,
      `auth-modals`, `button`, `glass-btn`, `form`, `card`, `badge`,
      `theme-toggle`, `float-btn`. Affects every page.
- [ ] **2c — home / profile family**: `avatar`, `page-dots`, `home-screen`,
      `minitable`, `stat-strip`, `upload-zone`, `file-review`,
      `settings-card`. Affects home / profile / objects.
- [ ] **2d — landing / marketing**: `hero`, `hero-steps`, `cta-btn`,
      `eyebrow`, `rotate-prompt`, `bottom-nav`. Affects landing.

### Phase 3 — Collision reconciliation (optional, after the move)
- [ ] Audit `modal.css` (app) vs `modal-sandbox.css` (vendor) — merge if
      they're the same concern, else keep both with clear names.
- [ ] Audit app `buttons.css` / `forms.css` / `filters.css` vs vendor
      `button.css` / `form.css` / `filter-by.css` — fold duplicates.
- [ ] Drop `-sandbox` suffixes.
- This is cleanup, not migration — do it lazily; it does not block Q3.

### Phase 4 — JS + cut the cord
- [ ] Copy `redpash-components/js/file-review.js` →
      `frontend/scripts/vendor/file-review.js` (or `frontend/vendor/`).
      Repoint `index.html:86`.
- [ ] `grep -rn "/vendor/" frontend/` → must be **empty**.
- [ ] Remove the mount from `backend/crates/api/src/routes/mod.rs`:
      delete the `components` `ServeDir` + its `.nest_service(
      "/vendor/redpash-components", …)` line + the comment block.
- [ ] SW bump. Full regression pass on all 7 pages.
- [ ] Commit: `css: drop /vendor mount — all assets internalized`.

### Phase 5 — Verify (definition of done — see Q3)

**Effort:** ~5 batches of edits. Each batch is a handful of file copies + a
mechanical `@import` find-and-replace. Low-risk because byte-identical
copies can't change rendering — the only real risk is a typo'd path, which
a 404 in DevTools surfaces immediately.

---

## Q3 — End state ("no import from the external library")

Done when **all** of these hold:

- [ ] `grep -rn "/vendor/" frontend/` returns nothing — no CSS `@import`,
      no `<script src>`, no `<link href>`.
- [ ] `backend/crates/api/src/routes/mod.rs` no longer mounts
      `/vendor/redpash-components` (the `ServeDir` + `nest_service` gone).
- [ ] Every `styles/**/*.css` `@import` points at `/styles/…`.
- [ ] `redpash-components/` is no longer read by the running app. It can be
      archived or kept solely for the sandbox/demo — the app no longer
      depends on it.
- [ ] All CSS (and `file-review.js`) is under `redpash-app` git — the
      non-version-controlled gap is closed.
- [ ] All 7 pages render identically to before (byte-identical copies → no
      visual diff expected).
- [ ] SW `CACHE_VERSION` bumped; one hard-refresh picks up the new paths.

### Notes / watch-outs
- **Token rebinding** — the library uses bare token names (`--bg`,
  `--accent`); pages re-bind them in scoped blocks. `tokens.css` moves
  verbatim — no change needed; the rebinding in page CSS still works.
- **`@import` order is load-bearing** — later imports override earlier
  ones. Preserve the exact order in every file when repointing.
- **Don't migrate dead files** — `carousel`, `gradients`, `help-content`,
  `progress`, `tokens-gradient` are imported by nothing. `side-panel-tabs`
  is orphaned by the ditched Reports rebuild — migrate it only when Reports
  is rebuilt.
- **SW caching** — component CSS is cache-first; every batch needs a
  `CACHE_VERSION` bump or the browser keeps stale paths.
- **`redpash-components/` stays put during migration** — it's the fallback.
  Only stop the app reading it (Phase 4); don't delete the directory.
