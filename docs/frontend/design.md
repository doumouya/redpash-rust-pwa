---
title: Design tokens
section: Frontend
order: 0
---

# Design tokens

All visual constants live as CSS custom properties on `:root` in
`frontend/styles/main.css`. Component sheets in `styles/components/`
read them; **no component should hard-code a colour**.

## Brand

| Token                  | Default    | Notes |
|------------------------|------------|-------|
| `--rp-accent`          | `#b3001b`  | The red. Re-bindable per user via prefs. |
| `--rp-accent-soft`     | `#f7d6dc`  | Hover backgrounds, danger button bg |
| `--rp-accent-strong`   | `#7a0013`  | Pressed / active state |

## Surfaces

`--rp-bg`, `--rp-surface`, `--rp-surface-2`, `--rp-border`,
`--rp-border-strong`. All four flip automatically under
`prefers-color-scheme: dark`.

## Text

`--rp-text`, `--rp-text-muted`, `--rp-text-inverse`.

## Geometry

`--rp-radius` (8px) / `--rp-radius-lg` (14px), `--rp-shadow` /
`--rp-shadow-lg`, `--rp-topbar-h` (56px), `--rp-gutter` (20px).

## Per-user overrides

Settings (Phase 4) writes a tiny `<style>` tag to `<head>` rebinding
`--rp-accent` etc. — no component sheet needs to know.

## Naming convention vs `redpash-components`

The shared design-system library lives at
`/home/mansa/redpash-components/` and will be consumed by several
apps (RedPash, future Django builds). It is **deliberately generic**:

- **Library tokens** use **bare names** — `--bg`, `--surface`,
  `--accent`, `--text`, `--muted`, `--green`, `--red`, etc. — defined
  on `:root` in the library's `tokens.css`. Library component sheets
  (`button.css`, `modal.css`, …) reference `var(--bg)` directly.
- **Each consuming app preserves its own prefix** for its tokens.
  RedPash uses `--rp-*` (`--rp-bg`, `--rp-accent`, `--rp-surface`,
  `--rp-text-muted`, …).

This means: **never rename either side to match the other**. The
library has to stay reusable for the next app's naming convention,
and the app's existing sheets shouldn't be churned every time the
library refactors.

### Library files: `tokens.css` · `reset.css` · `shell.css`

The library splits its global CSS into three files so apps can mix
and match without pulling in opinionated body chrome they don't want:

- **`tokens.css`** — pure token declarations: `:root` (dark default),
  `[data-theme="light"]`, `[data-theme="system"]` (with
  `prefers-color-scheme` media queries), smooth theme-transition rules.
  **Always loaded.**
- **`reset.css`** — **defensive** universal element defaults:
  `* { box-sizing }`, `a { color: inherit; text-decoration: none }`,
  `button { font-family: inherit }`, `.bi` icon normalisation. Safe to
  load globally on any consuming app — these prevent app-side element
  selectors (`a:hover {…}`, etc.) from leaking into library components
  that use those elements. **Always loaded.**
- **`shell.css`** — **opt-in** body chrome + universal margin/padding
  zero: `html, body { height: 100%; overflow: hidden }`,
  `body { display: flex; flex-direction: column; font-size: 0.8125rem }`,
  `*, *::before, *::after { margin: 0; padding: 0 }`. Opinionated —
  apps with raw `<h1>` / `<p>` / `<ul>` content that relies on
  browser-default spacing should NOT load this globally.

Loading matrix:

| Surface | tokens | reset | shell |
|---|---|---|---|
| redpash-demo (`redpash-demo/index.html`) | ✓ | ✓ | ✓ |
| redpash-app `main.css` (global) | ✓ | ✓ | — |
| redpash-app `pages/landing.css` (per-page) | (inherited) | (inherited) | ✓ |

### Full-bleed pages: the `body[data-chrome]` attribute

Some pages don't want the app's default chrome (`.rp-topbar` + `.rp-app`
gutter padding) — landing and home own their own float bars and need
to claim the viewport edge-to-edge.

Originally each such page used a `:has()` override (e.g. `body:has(#page-home) #topbar { display: none }`) in its per-page CSS. The problem: per-page `<link>` loads **after** `main.css`, so the default chrome flashed for ~50 ms before the override applied. Classic FOUC.

The fix lives in the router. Each `ROUTES` entry can declare a
`chrome` flag:

```js
{ path: "/home", … , chrome: "full" }
```

In `navigate()`, before mounting the partial:

```js
document.body.dataset.chrome = route.chrome || "default";
```

The matching `main.css` rules fire **immediately** when the attribute
flips — no waiting on per-page CSS:

```css
body[data-chrome="full"] #topbar { display: none; }
body[data-chrome="full"] .rp-app {
  padding: 0; min-height: 0;
  flex: 1; display: flex; flex-direction: column;
}

/* Brand accent also re-binds to the library's catppuccin blue on
   full-bleed surfaces, because home-screen.css / hero.css / auth-modals.css
   compose var(--accent) expecting the library palette. The rest of
   the app keeps RedPash red. */
body[data-chrome="full"]                          { --accent: #89b4fa; }
html[data-theme="light"] body[data-chrome="full"] { --accent: #4f8ef7; }
@media (prefers-color-scheme: light) { html[data-theme="system"] body[data-chrome="full"] { --accent: #4f8ef7; } }
@media (prefers-color-scheme: dark)  { html[data-theme="system"] body[data-chrome="full"] { --accent: #89b4fa; } }
```

Per-page CSS (`landing.css`, `home.css`) is now free to focus on
**inside-the-page** layout. Page-level shell decisions belong in
`main.css` keyed off `[data-chrome]`.

Adding a new full-bleed surface: set `chrome: "full"` on its route
and you're done — topbar hides, gutter zeroes, accent flips to
library blue, all from the single attribute. If a future full-bleed
page actually wants RedPash red, override `--accent` locally inside
its root selector.

### Layering discipline (what goes where)

The library leak class — where an app's global element selector beats
a library component's intent — is what motivated the
reset.css/shell.css split. To keep it from recurring:

1. **In `main.css`, no unqualified element selectors** beyond:
   - `html, body` body chrome (font-family, color, bg, height).
   - Things the library's `reset.css` already covers (anchors,
     buttons, `*` box-sizing).
   No `a:hover { … }`, no `h1 { font-size … }`, no `ul { … }`. Those
   are styling decisions that belong to specific components.
2. **App component sheets in `styles/components/`** target classes
   only (`.rp-btn`, `.rp-topbar`, etc.) — never bare elements.
3. **Per-page CSS in `styles/pages/`** can use element selectors
   scoped under a page-root class or ID (`#landing h1`,
   `.rp-docs__content a:hover`). The router removes the page CSS on
   navigation, so the rule's reach is bounded.
4. **If a styling decision keeps recurring across pages**, lift it
   into a class-based component sheet rather than a global element
   rule.

The library's `reset.css` is the defensive backstop: as long as it
sets the relevant element baseline (`a { color: inherit; text-decoration: none }`),
app-level element rules can't quietly clobber library components
even when discipline slips.

### Integration in the RedPash app (active)

`frontend/styles/main.css` does the alias-layer wiring:

```css
@import "/vendor/redpash-components/tokens.css";

@import "/styles/components/buttons.css";
/* …other app component sheets… */

:root {
  /* App brand override — library's catppuccin --accent → RedPash red. */
  --accent: #b3001b;

  /* Alias layer: library bare → app prefixed. */
  --rp-bg:      var(--bg);
  --rp-surface: var(--surface);
  --rp-surface-2: var(--over0);
  --rp-border:  var(--over1);
  --rp-text:    var(--text);
  --rp-text-muted: var(--muted);
  --rp-accent:  var(--accent);
  --rp-shadow:  var(--shadow-sm);
  --rp-shadow-lg: var(--shadow);
  --rp-radius:  var(--r);

  /* App-only tokens (no library counterpart) defined directly. */
  --rp-accent-soft:   #f7d6dc;
  --rp-accent-strong: #7a0013;
  /* …etc… */
}
```

`frontend/index.html` carries `<html data-theme="system">` so the
library's `prefers-color-scheme` branch activates by default. Settings
will later let users pin to `light` / `dark` via `prefs.theme`.

After the alias layer is in place:

- App-authored CSS continues to reference `var(--rp-bg)` etc. — no
  change needed.
- Library-authored CSS imported into the app references `var(--bg)`
  natively — works because the library's `tokens.css` defined them.
- The library's brand palette flows into the app via the alias layer;
  the app overrides the brand `--accent` to RedPash red so both
  library and app components render in brand.

### Class names

Library components name **primitives bare** (`.btn`, `.modal`,
`.badge`) and **composed variants `rp-`-prefixed** (`.rp-modal--glass`,
`.rp-rt-*`, `.rp-social-btn`); the app's own classes are `rp-`-prefixed
too. **No rename in either direction.**

Naming collisions to watch (same class, different definition):

| Class | Library | App |
|---|---|---|
| `.rp-btn` | `components/button.css` | `frontend/styles/components/buttons.css` |
| `.rp-modal` | — (library modal is bare `.modal` / `.rp-modal--glass`) | `frontend/styles/components/modal.css` |

The library's primitives use **bare** names (`.modal`, `.btn`, `.badge`)
per its "un-prefixed primitive" convention; only its composed variants
are `rp-`-prefixed (`.rp-modal--glass`, `.rp-rt-*`). So `.rp-modal` is
App-only — no true collision — but the two modal *systems* coexist:

- **`scripts/ui/modal.js` `openModal()`** — migrated to the library
  glass modal (`<dialog class="rp-modal--glass">` + `.modal`, styled by
  `auth-modals.css`). The preferred helper for new modals; the
  `dialog.rp-modal--glass` glue in `styles/components/modal.css` just
  neutralises the `<dialog>` UA box.
- **`.rp-modal`** (`frontend/styles/components/modal.css`) — the App's
  older native-`<dialog>` modal, still used by the Cleaner tool modals
  and the Reports chart modal. Retire per-surface as they migrate.
