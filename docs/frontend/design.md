---
title: Design tokens
section: Frontend
order: 0
last modified date: 2026-05-20
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

## Token naming: bare names + the `--rp-*` alias layer

The component CSS was internalized from the old `redpash-components`
design-system library into `frontend/styles/` (see
[`all-css-in-redpash-project.md`](../../all-css-in-redpash-project.md)).
That library used **bare token names**, and the internalized sheets
keep them — so the convention persists:

- **Component tokens** use **bare names** — `--bg`, `--surface`,
  `--accent`, `--text`, `--muted`, `--green`, `--red`, etc. — defined
  on `:root` in `styles/base/tokens.css`. Component sheets
  (`button.css`, `modal.css`, …) reference `var(--bg)` directly.
- **App-authored sheets keep the `--rp-*` prefix** — `--rp-bg`,
  `--rp-accent`, `--rp-surface`, `--rp-text-muted`, …

This means: **never rename either side to match the other.** They're
bridged by an alias layer in `main.css` (`--rp-bg: var(--bg);`) — see
the Integration section below. Bare-named component sheets and
`--rp-*` app sheets coexist without churn.

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
- **`shell.css`** — opinionated body chrome + universal margin/padding
  zero: `html, body { height: 100%; overflow: hidden }`,
  `body { display: flex; flex-direction: column; font-size: 0.8125rem }`,
  `*, *::before, *::after { margin: 0; padding: 0 }`. The redpash-app
  **does not import `shell.css`** any longer — these rules are inlined
  into `frontend/styles/main.css` scoped to `body[data-chrome="full"]`
  (see *Full-bleed pages* below) so they apply only when the active
  route opts in. Apps with raw `<h1>` / `<p>` / `<ul>` content that
  relies on browser-default spacing should NOT load `shell.css`
  globally either.

Loading matrix:

| Surface | tokens | reset | shell |
|---|---|---|---|
| redpash-demo (`redpash-demo/index.html`) | ✓ | ✓ | ✓ |
| redpash-app `main.css` (global) | ✓ | ✓ | — (inlined under `body[data-chrome="full"]`) |
| redpash-app per-page CSS | (inherited) | (inherited) | (inherited via `[data-chrome="full"]`) |

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
body[data-chrome="full"] {
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition: background 0.25s, color 0.25s;
  -webkit-font-smoothing: antialiased;
}
html:has(body[data-chrome="full"]) { overflow: hidden; }
body[data-chrome="full"] .rp-app {
  padding: 0; min-height: 0;
  flex: 1; display: flex; flex-direction: column;
}

/* Slate-cobalt / Arctic-blue token palette — applied to every full-
   bleed page (landing / home / cleaner / objects / reports / profile).
   The library's catppuccin tokens stay for non-full-bleed pages (e.g.
   settings, docs). Light theme + system-light @media overrides set
   the same tokens to the Arctic-blue values; see main.css for the
   full block (~70 lines, omitted here). */
body[data-chrome="full"] {
  --bg:      #0f172a;
  --surface: #1e293b;
  --text:    #e2e8f0;
  --accent:  #60a5fa;   /* cobalt, replaces the library default */
  /* --over0, --over1, --sub, --muted, --border, --hover, --selected,
     --active-bg + the --rp-* alias mirrors all rebind here. */
}

/* App page background — single shared gradient, theme-switched via
   --rp-bg-app (also defined in main.css). Each full-bleed page
   references it once: `background: var(--rp-bg-app)`. */
```

Per-page CSS (`landing.css`, `home.css`, `cleaner.css`, …) is now free
to focus on **inside-the-page** layout. Page-level shell decisions
(body chrome, palette, page-bg gradient) belong in `main.css` keyed
off `[data-chrome]`.

Adding a new full-bleed surface: set `chrome: "full"` on its route
and you're done — topbar hides, gutter zeroes, slate-cobalt palette
applies, all from the single attribute. If a future full-bleed page
needs different tokens, override them locally inside its root
selector (specificity `#page-X` 0,1,0,0 beats `body[data-chrome]`
0,0,1,1).

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

The `reset.css` (in `styles/base/`) is the defensive backstop: as long as it
sets the relevant element baseline (`a { color: inherit; text-decoration: none }`),
app-level element rules can't quietly clobber library components
even when discipline slips.

### Integration in the RedPash app (active)

`frontend/styles/main.css` does the alias-layer wiring + hoists the
sandbox components every full-bleed page used to import per-page:

```css
@import "/styles/base/tokens.css";
@import "/styles/base/reset.css";
@import "/styles/base/backgrounds.css";

/* Components that own a base selector the whole app shares.
   Hoisted here so the .rp-btn / .rp-modal base has a single source
   of truth (used to be re-imported by every full-bleed page CSS). */
@import "/styles/components/glass-btn.css";
@import "/styles/components/modals-sandbox.css";

/* App-owned component sheets — these reference --rp-*. buttons.css
   and modal.css now hold only what the library doesn't: the
   --primary/--ghost/--danger/--sm button modifiers and the
   <dialog>-glue for ui/modal.js's openModal(). */
@import "/styles/components/buttons.css";
@import "/styles/components/topbar.css";
@import "/styles/components/toast.css";
@import "/styles/components/modal.css";
@import "/styles/components/filters.css";
@import "/styles/components/forms.css";

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

  /* App page-bg gradient — slate-cobalt dark / Arctic-blue light.
     Theme-switched via overrides under html[data-theme="light"]
     and @media (prefers-color-scheme: light) html[data-theme="system"].
     Each full-bleed page references it once. */
  --rp-bg-app: linear-gradient(160deg, #020b18 0%, #0b1a35 45%, #0f1a45 100%);
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
  the app overrides the brand `--accent` to RedPash red so app
  components (topbar, redtable chrome, modifier buttons) render in
  brand. Full-bleed pages then rebind `--accent` to cobalt blue
  (`#60a5fa`) via the `body[data-chrome="full"]` palette block so
  library-composed surfaces (hero gradients, social button hovers,
  modal accents) read as the sandbox's slate-cobalt theme.

### Per-page CSS contract

Each `frontend/styles/pages/X.css` now contains **only page-specific
layout / chrome / per-page customizations**. Hoisted to `main.css`
and never re-imported per-page:

- `shell.css` body chrome (overflow/flex/smoothing) — applies via
  `body[data-chrome="full"]`.
- `glass-btn.css` (`.rp-btn` base) and `modals-sandbox.css`
  (`.rp-modal` base) — load globally.
- Slate-cobalt / Arctic-blue token palette (`--bg`, `--surface`,
  `--text`, `--accent`, …) — bound on `body[data-chrome="full"]`.
- App page-bg gradient — `var(--rp-bg-app)` token.
- Root `html { font-size: 112.5% }` — set once globally.

Adding a new sandbox-style page: scaffold it as `chrome: "full"` and
the chrome + palette + gradient + button/modal base all apply
automatically. Per-page CSS only needs the layout for that page's
unique geometry.

### Class names

Library components name **primitives bare** (`.btn`, `.modal`,
`.badge`) and **composed variants `rp-`-prefixed** (`.rp-modal--glass`,
`.rp-rt-*`, `.rp-social-btn`); the app's own classes are `rp-`-prefixed
too. **No rename in either direction.**

Naming-collision history (resolved during the import-layer cleanup):

| Class | Owner now | Previously also defined in |
|---|---|---|
| `.rp-btn` (base + states) | library `components/glass-btn.css` (hoisted globally via `main.css`) | app `frontend/styles/components/buttons.css` — base stripped, only `--primary`/`--ghost`/`--danger`/`--sm` modifiers remain |
| `.rp-modal` (base + overlay) | library `components/modals-sandbox.css` (hoisted globally via `main.css`) | app `frontend/styles/components/modal.css` — legacy `.rp-modal__head/__title/__body/__close/__actions` BEM stripped; only `dialog.rp-modal--glass` `<dialog>`-glue + `.modal-actions` remain |

The library's primitives use **bare** names (`.modal`, `.btn`, `.badge`)
per its "un-prefixed primitive" convention; only its composed variants
are `rp`-prefixed (`.rp-modal--glass`, `.rp-rt-*`). The two modal
*systems* still coexist:

- **`scripts/ui/modal.js` `openModal()`** — migrated to the library
  glass modal (`<dialog class="rp-modal--glass">` + `.modal`, styled by
  `auth-modals.css`). The preferred helper for new modals; the
  `dialog.rp-modal--glass` glue in `styles/components/modal.css` just
  neutralises the `<dialog>` UA box.
- **`.rp-modal-overlay` + `.rp-modal` + `.rp-modal-hdr` / `.rp-modal-ttl`**
  (library `modals-sandbox.css`, loaded globally) — the sandbox
  modal recipe used by every cleaner tool modal, every objects /
  reports modal, and the file-review modal on home. The legacy app
  BEM (`.rp-modal__head` / `__title` / …) is gone from live code.
