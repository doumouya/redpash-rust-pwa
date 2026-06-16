# Conventions, the ui-fork-audit, and the gates

This is the rulebook that keeps the frontend from forking the way its predecessor
did (its atoms diverged into 137 same-class overrides because nothing stopped
pages from restyling framework CSS). Here, forking is a **CI failure**, not a
review note — and the audit "has caught its own author."

> Canonical source: the `vanilla-web` skill (WSL `~/.claude/skills/vanilla-web/`)
> — `SKILL.md` (baseline) + `references/redpash.md` (the RedPash overlay). The
> skill's rule: **the live source wins over the snapshot** — verify against the
> actual files.

---

## The rules you must follow

### Layering — `rp-` owns the framework, `pg-` owns pages
- **Components** at `framework/<name>/<name>.{js,css}`; the `.css` is the **sole owner** of its `.rp-<name>-*` classes. A component owns ALL its markup; config is data + callbacks (no DOM/HTML in).
- **Pages** at `apps/<app>/<page>/<page>.{html,js,css}`; get framework markup ONLY via `mount*()`; root every CSS selector at `.pg-<app>-<page>`; may **read** `--rp-*` vars but never set framework classes or style `.rp-*`.
- **A variant is a framework commit, never a page override.** New look ⇒ add a knob/option to the component.

### The component contract
Every component:
- exports `mount<Name>(host, config)` returning `{ el?, update, destroy }` (the common floor; some add more — `surface.section`, `rail.setGroups/setActive/toggleCollapse`, `redtable.setInteraction`, `workspace-panels.togglePanel`, etc.);
- builds DOM via `el()` from `boot/dom.js` + `textContent` (never untrusted `innerHTML`);
- **self-registers** at module load: `register("<name>", mount<Name>)`;
- carries a header comment naming the mount signature and its `--rp-<name>-*` **knobs** (R7). None? write `knobs: none`. Keep it in the **first 600 bytes** of the CSS — the audit only reads that far.

### Tokens + relative units
- Tokens in `styles/tokens.css` (full vocabulary below). Never hardcode a hex — always `var(--rp-…)`.
- **Relative units, always** (`rem`/`em`/`%`/`ch`/`fr`). `px` is allowed ONLY for hairline borders (`1px solid var(--rp-border)`), the `--rp-radius-*` tokens (corners don't scale with font size), and shadow offsets. A raw `px` size/padding/margin/font-size is a bug. *(This convention is not audited — CI won't catch it — but it is mandatory.)*

### Honest affordances + client-first UX
- **Never render a control the backend can't honor** (no sort chevrons until `?sort` exists; a launcher card only for a built page; remove a no-op button, don't grey it).
- Client-first: paint from cache, then correct after the await; optimistic with revert + toast.
- **One engine, two surfaces:** the Rust `data` crate runs natively AND as wasm; a client-side score/filter must be byte-identical to the server's.

---

## The ui-fork-audit — R1 through R9

`tools/ui-fork-audit/audit.js` walks `frontend/` (skipping `vendor/`, `wasm/`,
`dist/`, `node_modules/`). **Exit code = violation count**; any violation fails
CI. On success: `ui-fork-audit: OK — no forks, no overrides, one owner per class`.

| Rule | Enforces |
|------|----------|
| **R1** | Every selector in an apps sheet starts with its page-root class `.pg-<app>-<page>` (derived from the path). |
| **R2** | No `.rp-` selector outside `framework/` CSS (reading `--rp-` vars is fine; this bans *styling* `.rp-*`). |
| **R3** | No `!important` anywhere in frontend CSS. |
| **R4** | Each `.rp-<name>` class is owned by **exactly one** framework sheet (collision = fork). |
| **R5** | No `#id` selectors — `#app` in `styles/base.css` is the only exception. |
| **R6** | `@import` only in `styles/main.css`; every sheet imported exactly once; all framework imports precede the first apps import. |
| **R7** | A `--rp-*` property **set** in an apps sheet must be a documented component **knob** (a framework header `knobs: --rp-x --rp-y`). |
| **R8** | No `rp-` class **literals** in apps JS/HTML (`--rp-` var reads + `data-rp-theme` allowed). Pages get framework markup only via `mount*()`. |
| **R9** | No inline styles in apps: no `style=` in `.html`, no `.style.` writes in `.js`. Framework allowlist for measured geometry: `virtual-rows.js`, `menu.js`. |

> Common trip-ups: needing `width:100%` on a composed native control (e.g. a
> `<select>` inside your component) — target the **element/tag** within your own
> `.rp-<name>-*` wrapper (`.rp-rb-measure select { width:100% }`), never the
> `.rp-select` class another sheet owns (R4). And a page needing a component
> tweak: add a knob (R7), don't reach in.

---

## The gates — `sh tools/ci.sh`

Run the whole gate before committing. Health-check style (**exit code = failed
steps**), in order:

1. `sh tools/purity-check.sh` — `cargo check --target wasm32-unknown-unknown -p data` (with `RUSTFLAGS='--cfg getrandom_backend="wasm_js"'`). The `data` crate must compile to wasm — zero io/http/threads/time. ("One engine, two surfaces.")
2. `cd backend && cargo check --workspace`
3. `cd backend && cargo test --workspace`
4. `node tools/ui-fork-audit/audit.js` — R1–R9.
5. `sh tools/test-fe.sh` — `node --test frontend/tests/*.test.js` (node:test only — no JS test framework, a repo rule; prints "no frontend/tests/ yet" + exits 0 if absent).
6. `sh tools/build-fe.sh` → `node tools/build-fe.mjs` — the hashed release build, which **self-checks the shipped module graph** (a typo'd import fails the build here, not at runtime).

> `tools/wasm-smoke.mjs` is **not** in `ci.sh` — run it after `tools/build-wasm.sh`
> when you touch the engine. It `initSync`s the built wasm, enumerates exports,
> then exercises `parse_score` + the resident `Workbook` (`from_csv → page →
> filter_page` that DROPS rows → `score`), asserting exact shapes. This is the
> path that caught the predecessor's `.enable_time` runtime panic a green `cargo
> check` hid.

### `build-fe.mjs` — the hashed release build
`frontend/` → `frontend-dist/`. Excludes dev-only artifacts (`framework-sandbox.html`,
`tests/`, `package.json`, `.d.ts`). **Flattens the `styles/main.css` `@import`
tree into one `styles/main.<hash>.css`** (manifest order = cascade order). Hashes
every `.js` (except `service-worker.js`) to `name.<sha1-12>.js` and writes an
**import map** in `index.html` so both static and dynamic `import()` resolve to
the hashed file. Entry points (`index.html`, the `.html` partials, the SW) stay
unhashed + no-cache. The hash IS the cache version — nothing goes stale, nobody
hand-bumps.

### `framework-sandbox.html` — the completeness proof
A dev-only page (excluded from the dist) that imports + renders **every registered
component from fixtures** and asserts the count via `listComponents().length`. The
contract: *every page must assemble from registered components + fixtures only — no
page module is written until its fixtures render.* New shared UI proves out here
first.

---

## How to add a new component — checklist

1. **Create the pair** `framework/<name>/<name>.js` + `<name>.css`.
2. **Header comment** in the `.js`/`.css` naming the mount signature + `knobs:` (or `knobs: none`), near the top (first 600 bytes of the CSS).
3. **Export `mount<Name>(host, config)`** → `{ el?, update, destroy }`. Config is data + callbacks only — never DOM/HTML. Build with `el()` + `textContent`.
4. **Self-register**: `import { register } from "../registry/component-registry.js";` then `register("<name>", mount<Name>);` at the bottom.
5. **CSS owns its `.rp-<name>-*` classes and only those** (R4/R2). Tokens only, relative units, no `!important` (R3), no `#id` (R5). Page-tunable values → `--rp-<name>-*` knobs in the `knobs:` header (R7).
6. **One `@import` in `styles/main.css`**, among the framework imports, before any apps import (R6).
7. **Add a fixture** to `framework-sandbox.html` rendering every variant from data.
8. **Pages consume only via `mount<Name>()`** — no `rp-` literals or inline styles in apps (R8/R9).
9. **If it has JS behavior worth locking down**, add a `node:test` under `frontend/tests/*.test.js`.
10. **Run `sh tools/ci.sh`** (and `node tools/wasm-smoke.mjs` after `tools/build-wasm.sh` if you touched the engine).

---

## CSS architecture & design tokens

### The manifest — `styles/main.css`
**The only file that may contain `@import`** (R6). A sheet not named here is not
in the app. Three numbered tiers, and **manifest order is cascade order**:

1. **Foundation** — `tokens.css`, `prefs.css`, `base.css`
2. **Framework components** — every `framework/<name>/<name>.css`
3. **Page sheets** — `apps/<app>/<page>/<page>.css`

Foundation → framework → pages, so framework wins over base and pages layer on top
without `!important`. (Bootstrap Icons loads via a plain `<link>` in `index.html`,
*not* an `@import`, so its `@font-face url()`s resolve relative to `/vendor/`.)

### Token vocabulary — `styles/tokens.css`
Two tiers: **tier 1 (structure)** in `:root`, theme-agnostic; **tier 2 (palette)**
per-theme blocks remapping the *same* `--rp-*` color names.

- **Spacing** (`:root`): `--rp-sp-1:.25rem`, `-2:.5rem`, `-3:.75rem`, `-4:1rem`, `-5:1.5rem`, `-6:2rem`, `-8:3rem` (the scale **skips `-7`**).
- **Radius** (px on purpose): `--rp-radius-sm:7px`, `--rp-radius:10px`, `--rp-radius-lg:16px`, `--rp-radius-pill:999px`.
- **Type**: `--rp-text-xs:.75rem`, `-sm:.8125rem`, `-md:.9375rem` (body default), `-lg:1.125rem`, `-xl:1.5rem`, `-2xl:2.25rem`. Families `--rp-font`, `--rp-font-mono`.
- **Density rhythm**: `--rp-row-h:2.25rem`, `--rp-ctl-h:2rem`, `--rp-pad-x:.75rem`, `--rp-gap:.5rem`, `--rp-topbar-h:3.25rem`, `--rp-rail-w:15rem`. (Components consume these; `prefs.css` retunes them globally per density.)
- **Motion**: `--rp-ease:cubic-bezier(.4,0,.2,1)`, `--rp-fast:.12s`, `--rp-slow:.22s`.
- **Breakpoints**: `--rp-bp-lg:80rem` (1280px), `--rp-bp-md:64rem` (1024px — the floor), `--rp-bp-sm:48rem` (768px). CSS can't `var()` in a `@media`, so each media rule repeats the rem literal with a `/* --rp-bp-* */` comment to stay grep-synced.

**Two themes only — `new-dark` (default) and `new-light`.** RedPash red is
`--rp-accent:#f04438`. Each theme block is selected by three selectors (`:root`,
`html[data-theme="…"]`, `[data-rp-theme="…"]`) so a nested element can preview a
theme without duplication. Both define the identical token set — `--rp-bg`,
`--rp-surface`, `--rp-surface-2`, `--rp-border`, `--rp-text`, `--rp-text-dim`,
`--rp-text-mute`, `--rp-accent`, `--rp-accent-soft`, `--rp-on-accent`, `--rp-ok`,
`--rp-warn`, `--rp-info`, `--rp-danger`, `--rp-hover`, `--rp-glass`,
`--rp-glass-blur`, `--rp-shadow`, `--rp-ring` — plus `color-scheme`. There is **no
catppuccin, no `--rp-accent-2`/-mauve/-teal/-peach**.

### Theme / density / font-size — document data-attributes
Carried on `<html>` data-attributes, applied **pre-paint** by the FOUC script in
`index.html` (reads `rp-pref-<name>` from localStorage); the server cascade
corrects after boot.
- `html[data-theme="new-dark"|"new-light"]` swaps the palette block.
- `html[data-density="compact"|"comfortable"]` (`prefs.css`) retunes the rhythm tokens.
- `html[data-fontsize="sm"]{font-size:14px}` / `["lg"]{font-size:17px}` scales the root, so all `rem` tokens scale. **The default root is the browser's 16px** (no `html{font-size}` rule) — 14px is *only* the `sm` preference.

**Components never branch on these attributes.** Prefs retune the rhythm tokens;
components just consume tokens. One knob, not per-sheet conditionals.

### Knobs currently documented (R7)
`--rp-redtable-max-h` (redtable), `--rp-atom-radius` (atoms), `--rp-rail-w`
(rail), `--rp-wsp-left-w --rp-wsp-right-w` (workspace-panels). An apps sheet may
set *only* declared knobs.
