---
name: redpash-frontend
description: >-
  How to build the RedPash frontend — the vanilla-JS + vanilla-CSS PWA in this repo
  (redpash-rust-pwa, frontend/). Use this WHENEVER you add or edit anything under
  frontend/ — a framework component, an app page, CSS, or one of the grid / table /
  chart / dashboard families — so the work matches the house style AND passes the
  ui-fork-audit gate (R1–R9). Covers the mount<Name> component pattern, the
  assemblePage page pattern, the .rp-/.pg- class discipline, relative-units, reusing
  the existing component families, and running the FE gates. Reach for it even when
  the user just says "add a button / page / chart / table" or "tweak the UI" in this
  repo — don't hand-roll RedPash frontend without it, or the gate will bounce you.
---

# Building the RedPash frontend

Vanilla JavaScript + vanilla CSS, **no frameworks, no build-step magic**. The guiding
split is **"Rust owns data, JS owns pixels"** and **client-first** (customer data lives
on-device; the frontend is rendering + orchestration over a thin API). The house style is
not optional decoration — a CI gate (`tools/ui-fork-audit/audit.js`, in `tools/ci.sh`)
**mechanically enforces** the rules below, so writing against them just means rework.

## The component pattern (`frontend/framework/`)

A reusable component lives at `framework/<name>/<name>.{js,css}` and follows one shape:

- Export `mount<Name>(host, cfg)`: it **builds its own DOM with `el()`**, `host.append(...)`s
  it, and returns a handle. The handle floor is `{ el, update(partial), destroy() }`;
  deviations are noted in the component's header comment.
- End the JS with `register("<name>", mount<Name>)`.
- The `.css` is the **sole owner** of its `.rp-<name>-*` classes — no other sheet styles them.
- Imports are **relative**: `el`/`esc`/`qs` from `../boot/dom.js`, `api` from `../boot/api.js`,
  `register` from `../registry/component-registry.js`, leaf builders from `../atoms/atoms.js`.
- Build DOM with `el(tag, attrs, ...children)` — **never `innerHTML`** (XSS + it trips R8).
  `el` sets text children as `textContent` (safe); any caller string that must reach
  `innerHTML` goes through `esc()` first.

Why: every component being a self-contained, self-registering, sole-owner unit is what lets
the app stay forkless and lets the gate prove "one owner per class."

## The page pattern (`frontend/apps/`)

A page is `apps/<app>/<page>/<page>.{html,js,css}`:

- `.html` is a single root: `<div class="pg-<app>-<page>" data-pg="root"></div>`.
- `.js` default-exports `mount(root, ctx)` — it composes `assemblePage(root, { session:
  ctx.getSession(), activePageId, title, meta?, rail?, sections:[{key}] })` (the topbar + rail +
  surface chrome) and mounts framework components into `page.section(key)`. Returns `{ destroy }`.
- `.css` is scoped to `.pg-<app>-<page>` and `@import`-ed in `styles/main.css` (page section).
- Register the page in `framework/boot/apps.js` (`{ id, label, icon, built: true }`).
- **Pages COMPOSE; they don't reinvent.** Need a table → `mountObjectList`/`mountGridView`. A
  chart → `framework/chart`. A canvas → `framework/dashboard-grid`. A dialog → `modal`.
  `apps/admin/registry/` and `apps/admin/cases/` are thin model pages — copy their shape.

## The R-rules (what the gate checks, and why)

- **R1** every selector in an app's CSS starts `.pg-<app>-<page>` — a page can't leak styles
  into shared chrome.
- **R2** no `.rp-` selectors outside `framework/` CSS — framework owns its classes; pages
  theme via tokens, not by restyling framework internals.
- **R3** no `!important` — cascade + specificity only.
- **R4** each `.rp-<name>` class is owned by exactly ONE framework sheet (the no-forks rule).
  A descendant selector that *references* another component's class for ancestor-context
  sizing (e.g. `.rp-chart-card .rp-title`) is fine — declaring/owning it twice is not.
- **R5** no `#id` selectors (only `#app` in `base.css`).
- **R6** `@import` lives **only** in `styles/main.css`; each sheet imported once; framework
  sheets before page sheets.
- **R7** a page may *set* a `--rp-*` custom property only if the framework component documents
  it as a knob in its sheet header.
- **R8** no `rp-` class literals in apps JS/HTML — pages mount components, they don't
  hand-write framework markup. (Reading `var(--rp-*)` is fine; the literal substring `rp-`
  anywhere — even in a comment — trips it, so phrase comments around it.)
- **R9** no `style=` attributes or `.style.` writes in apps JS/HTML — layout is classes, not
  inline styles.

**Crucial scope:** R8/R9 scan **only `apps/`**. Framework components freely use `.style` and
`rp-` — that's where dynamic/measured geometry lives (`virtual-rows`, `menu`, `dashboard-grid`
place cells via `.style.gridColumn`). So: do geometry inside a framework component, and let the
page just compose it.

## Relative units

`rem`/`em`/`%` for anything sizeable; `px` only for hairlines (1px borders), radii, and shadow
offsets. Media-query `rem` resolves against the 16px root, so `64rem = 1024px` (the floor target).
Read tokens from `styles/tokens.css` (`--rp-sp-*`, `--rp-bp-*`, `--rp-surface`, `--rp-border`, …).

## Reuse before you build

Grep `framework/` first — the families already exist: **object-list** (generic typed table),
**redtable** + **grid-toolbar** + **grid-view** (the data-table family), **filter-panel**
(+ the shared `FilterNode`/`evalFilter`), **side-panel** / **modal** / **atoms** / **field** /
**select** / **menu**, the **rail** + **topbar** + **surface** (via `assemblePage`),
**chart** (ECharts) + **dashboard-grid** (the Designer canvas), **uploader**, **omni**,
**report-builder**, **column-manager**, **sql-editor**.

## Verify — don't declare done without the gates

```sh
node tools/ui-fork-audit/audit.js   # R1–R9 (exit code = violation count)
sh tools/test-fe.sh                 # node:test unit tests
sh tools/build-fe.sh                # hashed dist + module-graph self-check (catches a typo'd import)
```

All three run via `sh tools/ci.sh`. Node is **not** on the non-interactive shell PATH — export
`"$HOME/.nvm/versions/node/<ver>/bin"` first (quote it; the inherited PATH has `(x86)`).

## Go deeper (the canonical, maintained docs — this skill distills them)

- `docs/REDMAP.md` — the doc⇄code map; scan before diving.
- `docs/internal/code/frontend/README.md` — shell, routing, the three registries, the page contract.
- `docs/internal/code/frontend/components.md` — the full component reference (every family).
- `docs/internal/code/frontend/conventions.md` — R1–R9 in depth, the gates, tokens, how to add a component.
- `docs/internal/code/frontend/data-cleaner.md` — the Workspace + the client/server engine seam.
- `frontend/framework-sandbox.html` — the live component demo harness.
