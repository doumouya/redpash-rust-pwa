---
title: Landing page (`#/landing`)
section: Frontend
order: 10
---

# Landing page (`#/landing`)

The unauthenticated welcome surface. Visible to anyone, no session
needed; the app's topbar is hidden here so the hero can claim the
viewport edge-to-edge. The route is wired in
[`scripts/main.js`](../../../../frontend/scripts/main.js) under the
`ROUTES` table — `partial`, `script`, and `css` slots all point at
this page's files.

---

## Files

| File | Role |
|---|---|
| [`partials/landing.html`](../../../../frontend/partials/landing.html) | Markup. 1:1 with the redpash-demo's welcome surface (rotate prompt, brand mark, top-right float bar, bottom-left float bar, hero, modals, bottom nav). |
| [`styles/pages/landing.css`](../../../../frontend/styles/pages/landing.css) | Page-specific styling — component `@import`s, hero gradient, brand-mark progressive reveal, CTA shimmer, typist caret. Router swaps it on navigation. |
| [`scripts/pages/landing.js`](../../../../frontend/scripts/pages/landing.js) | Wires inline `onclick` handlers and per-page behavior (modal open/close, social login dispatch, theme cycle, language picker, typewriter). |
| [`scripts/main.js`](../../../../frontend/scripts/main.js) (shell) | Captures `beforeinstallprompt` at the shell level and owns `installPWA()`. The Download CTA stays hidden until the event arms. |

PWA assets used by the install flow:

- [`icons/favicon.svg`](../../../../frontend/icons/favicon.svg) — tab icon. Canonical Savate-900 R glyph extracted from the TTF as an inline `<path>` so it renders pixel-perfect with no font-load dependency.
- [`icons/logo.svg`](../../../../frontend/icons/logo.svg) — same recipe at 2× viewBox. Used by the topbar brand mark, the auth modal heading, and the manifest's `"sizes": "any"` icon slot.
- [`icons/icon-192.png`](../../../../frontend/icons/icon-192.png), [`icons/icon-512.png`](../../../../frontend/icons/icon-512.png) — Chromium PWA install requires PNG icons at these sizes; generated from `logo.svg` via `cairosvg`.

---

## Library components composed

Imported via `@import` in [`landing.css`](../../../../frontend/styles/pages/landing.css). All under `/vendor/redpash-components/`, served by the api crate's [`ServeDir` mount](../../../../backend/crates/api/src/routes/mod.rs).

```css
@import "/vendor/redpash-components/components/typography.css";
@import "/vendor/redpash-components/components/hero.css";
@import "/vendor/redpash-components/components/cta-btn.css";
@import "/vendor/redpash-components/components/hero-steps.css";
@import "/vendor/redpash-components/components/eyebrow.css";
@import "/vendor/redpash-components/components/rotate-prompt.css";
@import "/vendor/redpash-components/components/float-btn.css";
@import "/vendor/redpash-components/components/bottom-nav.css";
@import "/vendor/redpash-components/components/modal.css";
@import "/vendor/redpash-components/components/auth-modals.css";
@import "/vendor/redpash-components/components/theme-toggle.css";
@import "/vendor/redpash-components/components/button.css";
@import "/vendor/redpash-components/components/form.css";
```

The library's `tokens.css` + defensive `reset.css` are pulled in
globally from [`main.css`](../../../../frontend/styles/main.css), along
with `glass-btn.css` (`.rp-btn` base) and `modals-sandbox.css`
(`.rp-modal` base). The body chrome (full-viewport flex column +
hidden overflow) used to come from `shell.css` imported here — it's
now inlined in `main.css` scoped to `body[data-chrome="full"]`, which
this route triggers via its `chrome: "full"` flag in `ROUTES`. See
[design.md](../../design.md) for the layering discipline.

---

## Page-specific bits (NOT in the library)

These are the bespoke parts the library deliberately leaves to the
consuming page. Lifted from `redpash-components/redpash-demo`'s inline
`<style>` and `<script>` plus a couple of additions from the Django
`/welcome` reference.

### 1. Hero gradient

```css
.rp-hero { background-image: linear-gradient(135deg, #0f3460 0%, #3a1f6e 100%); }
html[data-theme="light"] .rp-hero {
  background-image: linear-gradient(45deg, #8ec5fc 0%, #c1d2ff 75%, #e0c3ff 100%);
}
```

Welcome-page-specific colors (blue/purple dark, blue/lavender/pink light).
Promote to a library component on the second consumer.

### 2. Brand-mark progressive reveal

The "R" is always visible (Savate 900); on hover, "edPash" letters fade in with an 80 ms stagger via `grid-template-columns: 0fr → 1fr`. JS adds `.rp-brand-mark--revealed` on first hover and never removes it, so the full name stays visible afterward.

```css
.rp-bm-rest { display: inline-grid; grid-template-columns: 0fr;
              transition: grid-template-columns 0.55s cubic-bezier(.4,0,.2,1); }
.rp-brand-mark:hover .rp-bm-rest,
.rp-brand-mark.rp-brand-mark--revealed .rp-bm-rest { grid-template-columns: 1fr; }
/* + per-letter opacity + transition-delay stagger */
```

JS hook in [`landing.js`](../../../../frontend/scripts/pages/landing.js):
```js
mark.addEventListener("mouseenter",
  () => mark.classList.add("rp-brand-mark--revealed"), { once: true });
```

### 3. Primary CTA shimmer

Continuous diagonal-highlight pulse on `.rp-cta-btn--primary`, ported from `clarna-django/static/css/landing.css`. Sweeps every 3.5 s after a 2 s warm-up. The library uses `::before` for the hover gradient — shimmer goes on `::after` so they coexist.

```css
@keyframes rp-cta-shimmer {
  0%   { background-position: -200% 0; }
  100% { background-position:  200% 0; }
}
.rp-cta-btn--primary::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(105deg, transparent 40%, rgba(255,255,255,.15) 50%, transparent 60%);
  background-size: 200% 100%;
  animation: rp-cta-shimmer 3.5s ease-in-out 2s infinite;
  pointer-events: none; border-radius: inherit;
}
```

### 4. Eyebrow typewriter

A `<span id="hero-typist">` inside `.rp-eyebrow` cycles 6 short phrases
in the current language. Port of `clarna-django/static/js/ui.js`'s
typist loop.

Phrase pools at module scope:

```js
window.__typistPhrases = {
  en: ["No more messy CSVs", "Fix duplicates in one click", … ],
  fr: ["Fini les CSV en désordre", "Corrigez les doublons en un clic", … ],
};
```

Tick timings: warm-up 1800 ms, type 52 ms/char, hold full phrase
2400 ms, delete 26 ms/char, gap 320 ms. Starts in `deleting=true` mode
at full length so the first action erases the static first-paint text
and reveals the next phrase.

A blinking caret rendered by `#hero-typist::after { content: '|' }`
with the `rp-typist-caret` keyframe.

`window.reloadTypistPhrases` is exposed so `setLang` can pick up a new
language's phrase array without remounting.

---

## JS wiring (inline `onclick` handlers)

All globals are defined inside `mount()` in
[`landing.js`](../../../../frontend/scripts/pages/landing.js) — the
router can't execute `<script>` tags inside injected partials, so the
markup uses `onclick="…"` attributes and we assign `window.*` in JS.

| Handler | Defined in | What it does |
|---|---|---|
| `openModal('login'\|'contact')` | landing.js | Adds `.open` to `#modal-<id>`; closes any other open overlay first. |
| `closeModal('login'\|'contact')` | landing.js | Removes `.open`. |
| `doLogin('Google')` | landing.js | Real OAuth — `location.href = "/api/auth/google/start"`. |
| `doLogin('Apple'\|'Facebook'\|'Twitter'\|'GitHub'\|'WeChat')` | landing.js | Toast "isn't wired yet — only Google for now." |
| `doContact()` | landing.js | Toast "isn't wired yet — email hello@redpash.com for now." |
| `rpToggleTheme()` | landing.js | Cycle `<html data-theme>` dark ↔ light with the icon spin-out / class-swap / spin-in port of `redpash-components/js/theme.js`. Persists to `localStorage["redpash-theme"]`. Updates `<meta id="meta-theme">` so the iOS tab bar / browser chrome follows. |
| `rpSetTheme(t)` | landing.js | Explicit setter (dark / light / system). Called by `rpToggleTheme`; Settings page will use it directly when 3-state UI lands. |
| `setLang('en'\|'fr')` | landing.js | Walk the I18N table; swap text/HTML on each selector; persist to `localStorage["redpash-lang"]`; refresh typewriter phrases. Other languages toast "not ready" and fall back to English. |
| `installPWA()` | **main.js** (shell) | Replay the captured `beforeinstallprompt` event. See PWA section below. |

`Escape` closes any open modal (document-level keydown listener
registered in `mount`).

---

## i18n (English + French)

Translation table at module scope of
[`landing.js`](../../../../frontend/scripts/pages/landing.js). Each row
is `{ sel, en, fr, html?, attr? }`. The `setLang(lang)` walker:

```js
for (const row of I18N) {
  const val = row[lang] ?? row.en;
  document.querySelectorAll(row.sel).forEach((el) => {
    if (row.attr === "placeholder") el.placeholder = val;
    else if (row.html)              el.innerHTML   = val;
    else                            el.textContent = val;
  });
}
```

**Adding a new translatable string:**
1. Add an `id` or `data-i18n=` hook to the element in `landing.html`.
2. Add one row to the `I18N` array in `landing.js`:
   ```js
   { sel: '[data-i18n="foo"]', en: "Foo", fr: "Foo en français" },
   ```
3. Add the same key to `window.__typistPhrases.{en,fr}` if it's a typist phrase.

**Adding a new language:**
1. Add the language code to the `supported` array in `setLang`.
2. Add the language's value to every row in `I18N`.
3. Add the phrase array to `window.__typistPhrases.<code>`.
4. Add a `<button class="rp-float-picker-opt" data-lang="<code>" onclick="setLang('<code>')">` to the picker in `landing.html`.

The float-bar label (`#ld-lang-label`) updates to the uppercase code
on switch (`EN` → `FR`); the picker's `.active` class moves with the
selection; `<html lang="…">` is set so screen readers and `:lang(x)`
selectors get the right value.

---

## Theme toggle

Port of [`redpash-components/js/theme.js`](../../../../redpash-components/js/theme.js).

- **Binary dark ↔ light** when the icon toggle is clicked; `"system"` only gets set via `rpSetTheme('system', this)` (Settings 3-state switch — future).
- **Icon spin animation** — `.rp-theme-icon` gets `opacity: 0; transform: scale(0.3) rotate(180deg)`; after 260 ms the class is swapped (`bi-sun-fill` ↔ `bi-moon-fill`) and the inverse transform restores it. The transition rule lives in the library's `tokens.css` (`html.rp-theme-transitioning .rp-theme-icon { transition: opacity 0.25s, transform 0.3s cubic-bezier(0.34,1.56,0.64,1) !important }`).
- **Whole-page fade** — `<html>` gets `.rp-theme-transitioning` for 400 ms; the wildcard rule in `tokens.css` cross-fades `background-color`, `color`, `border-color`, `box-shadow`, `fill`, `stroke`.
- **Persistence** — `localStorage["redpash-theme"]`. Restored on mount; the icon class is sync'd immediately (no animation) so the first paint already reflects the choice.
- **`<meta id="meta-theme">`** in `index.html` is updated on switch so iOS / Android browser chrome follows the theme.

---

## PWA install

The Download CTA is hidden by default (`style="display:none"`) and
revealed only when Chromium fires `beforeinstallprompt`. Pattern
mirrors Django `/welcome`: if the event never fires (Safari, Firefox,
or Chromium with criteria not met / already dismissed), the button
stays hidden — the **absence** of the button is the signal that
install isn't on the table.

```html
<button class="rp-cta-btn rp-cta-btn--ghost pwa-install-btn"
        aria-label="Download the app"
        onclick="installPWA()"
        style="display:none">
  …
</button>
```

The shell-level handler in
[`main.js`](../../../../frontend/scripts/main.js):

```js
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  _pwaPrompt = e;
  _showInstallBtns();          // reveals every .pwa-install-btn
});

window.installPWA = async () => {
  if (!_pwaPrompt) return;
  _pwaPrompt.prompt();
  try { await _pwaPrompt.userChoice; } catch {}
  _pwaPrompt = null;
  _hideInstallBtns();
};

window.addEventListener("appinstalled", () => {
  _pwaPrompt = null;
  _hideInstallBtns();
});
```

The listener is at the shell level (not in landing.js) because
`beforeinstallprompt` fires **very early** — before per-route modules
load. Capturing it in the dynamically-imported landing.js would race
the event.

PWA install criteria (Chromium):
- HTTPS or localhost ✓
- Valid manifest with `name`, `start_url`, `display: standalone`, and
  ≥ 192 × 192 icon that loads ✓ (the rasterized PNGs).
- Active service worker with a `fetch` handler ✓
- User engagement heuristics (visit twice, etc.) — gated by the
  browser. Bypass for testing: `chrome://flags/#bypass-app-banner-engagement-checks`.

---

## Modal stack

The hero CTAs and the float-bar Sign-in button all open one of two
modals from `auth-modals.css`'s glass shell (deep-blue → purple
gradient overlay, 1.75 rem backdrop blur):

**`#modal-login`** — `.rp-modal--glass` + 4 social buttons (Google /
Microsoft / Apple / Facebook) — order mirrors the Connected accounts
card on `/profile`. Only Google is wired to real OAuth; the other
three toast a placeholder via `doLogin()`. The login modal's "Contact
us" link in the footer opens `#modal-contact` (closing the login
modal first via `openModal`'s one-at-a-time rule).

**`#modal-contact`** — `.rp-modal--glass.modal-wide` + the Django-style
2-column name/email + company/phone rows + full-width message
textarea. Form fields are present but not yet wired to a backend
endpoint; the Send button toasts "isn't wired yet — email
hello@redpash.com for now."

Both modals close on **backdrop click** (overlay has
`onclick="closeModal(…)"`), **Escape** (document keydown listener),
and **CTA navigation** (clicking Google sign-in triggers
`location.href = …` which closes the page entirely). The X close
button was removed earlier per design preference.

---

## Naming / collision watch

| Class | Owned by |
|---|---|
| `.rp-hero` / `.rp-cta-btn` / `.rp-hero-steps` / `.rp-eyebrow` / `.rp-rotate-prompt` / `.rp-float-bar` / `.rp-float-btn` / `.rp-bottom-nav` / `.rp-modal--glass` / `.rp-wordmark` / `.rp-r` / `.rp-theme-icon` | Library (`/vendor/redpash-components/components/`) |
| `.rp-brand-mark` / `.rp-bm-rest*` / `.rp-cta-btn--primary::after` shimmer | This page (bespoke — promote to library on second consumer) |
| `.modal-overlay` / `.modal` / `.btn` / `.btn-primary` / `.form-input` / `.form-label` | Library (**primitive, unprefixed**) |
| `.rp-modal` / `.rp-btn` / `.rp-field` / `.rp-topbar*` | App (`frontend/styles/components/`) |

Critically: the library's `.btn` / `.modal` primitives use **unprefixed**
class names and don't collide with the app's `.rp-btn` / `.rp-modal`.
See [design.md → Class names](../../design.md#class-names) for the
full collision matrix.

---

## Visual fidelity vs the redpash-demo

The page is a near-1:1 copy of
[`redpash-components/redpash-demo/index.html`](../../../../redpash-components/redpash-demo/index.html)
lines 196-388, with these intentional differences:

- **Login modal**: only Google triggers real OAuth; the other social
  buttons are visual placeholders.
- **Contact form**: no `/api/contact` endpoint yet — Send toasts.
- **Download CTA**: hidden until `beforeinstallprompt` fires (Django
  pattern; the demo always shows it).
- **Brand accent (`--accent`)**: app-wide is RedPash red, but every
  full-bleed page (`body[data-chrome="full"]` — landing and home) gets
  the library's catppuccin blue (`#89b4fa` dark / `#4f8ef7` light) so
  the hero `<em>` word, the home Step 1 "import" tints, and the
  auth-modal social-button hovers all match the demo. App-side
  surfaces (topbar, redtable chrome, cleaner sidebar, etc.) keep the
  red brand. The rule lives in `main.css` next to the other
  `[data-chrome="full"]` shell rules — see [design.md → full-bleed pages](../../design.md#full-bleed-pages-the-body-data-chrome-attribute).

---

## Cache / refresh

Every change to `landing.html`, `landing.css`, `landing.js`, or any
imported library component triggers a cache bump in
[`service-worker.js`](../../../../frontend/service-worker.js). Hard
refresh (Ctrl+Shift+R) to see edits — and on the first visit after a
favicon change, also clear the favicon cache (DevTools → Application
→ Storage → Clear site data).
