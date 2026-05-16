---
title: Profile + Settings page (`#/profile`)
section: Frontend
order: 13
---

# Profile + Settings page (`#/profile`)

Full-bleed 2-step scroll-snap page composing the redpash-components
library. Mirrors `redpash-components/redpash-demo`'s `#page-home`
visual pattern (float bars, step-dots, hero-gradient step cards) but
holds the **profile** content on step 1 and the **settings** content
on step 2 — both ported from `clarna-django/templates/app.html`
(`#page-profile` + `#page-settings`).

`/settings` is still a separate route today for direct linking; it
falls through to the old minimal page. The intent over time is to
have it scroll into step 2 of `/profile` automatically.

---

## Files

| File | Role |
|---|---|
| [`partials/profile.html`](../../../../frontend/partials/profile.html) | Markup. Two `.hs-card` step cards inside a single `.home-steps` container, plus float bars + step-dots + contact modal. |
| [`styles/pages/profile.css`](../../../../frontend/styles/pages/profile.css) | Library `@import`s + scoped overrides that turn the cards into a frosted-glass family matching the corner float buttons; plan-card / connected-account / avatar-edit / edit-mode-toggle page-specific styles; avatar size bump matching the home page. |
| [`scripts/pages/profile.js`](../../../../frontend/scripts/pages/profile.js) | Load `/me` + counts, populate identity + form + connections + settings-step account row. IntersectionObserver for the step-dot sync. Inline-onclick globals. |
| [`scripts/main.js`](../../../../frontend/scripts/main.js) (shell) | Route flagged `chrome: "full"` → main.css hides topbar / zeroes `.rp-app` gutter / re-binds `--accent` to library catppuccin blue. |

---

## The 2 steps

| Step | Title | Card class | `data-step` | Content |
|---|---|---|---|---|
| 1 | Profile | `.hs-import` (blue gradient) | `1` | 2-column: Personal info + Security cards (left) · Usage stats strip + Plan & Billing + Connected accounts cards (right). A red-bordered Log out / Delete-account card sits full-width below the grid (no section heading). |
| 2 | Settings | `.hs-report` (purple gradient) | `2` | 2-column: Appearance card (left — theme switcher + topbar/footer position pickers + language pills) · Data & Export card (right — delimiter / encoding / export format). About card full-width below the grid. |

Each `.hs-card`'s `height` is overridden to `auto` inside `#page-profile`
so the cards grow to fit their content (the demo's default 100svh
would cap and force a nested scroll inside `.rp-set-page` — clunky
when we want a single outer scroll surface).

---

## Library components composed

```css
@import "/vendor/redpash-components/shell.css";          /* opt-in body chrome */

@import "/vendor/redpash-components/components/typography.css";
@import "/vendor/redpash-components/components/button.css";
@import "/vendor/redpash-components/components/form.css";
@import "/vendor/redpash-components/components/card.css";
@import "/vendor/redpash-components/components/modal.css";
@import "/vendor/redpash-components/components/auth-modals.css";
@import "/vendor/redpash-components/components/theme-toggle.css";
@import "/vendor/redpash-components/components/float-btn.css";
@import "/vendor/redpash-components/components/avatar.css";
@import "/vendor/redpash-components/components/page-dots.css";
@import "/vendor/redpash-components/components/home-screen.css";
@import "/vendor/redpash-components/components/settings-card.css";
@import "/vendor/redpash-components/components/stat-strip.css";
```

The `settings-card.css` component holds every "settings page primitive"
the page uses: `.rp-set-page` / `.rp-set-grid` / `.rp-set-col` /
`.rp-set-sh` / `.rp-card` / `.rp-set-row` / `.rp-set-row--col` /
`.rp-set-lbl` / `.rp-set-title` / `.rp-set-sub` / `.rp-set-divider` /
`.rp-set-input` / `.rp-set-input-wrap` / `.rp-set-input-link` /
`.rp-set-opt-grp` / `.rp-set-opt` / `.rp-set-opt--soon` / `.rp-soon` /
`.rp-set-acct-row` / `.rp-set-about` / `.rp-set-about-links` /
`.rp-set-sh--danger` / `.rp-card--danger` / `.rp-btn--danger-fill` /
`.rp-theme-sw` / `.rp-theme-btn`.

---

## Scoped overrides

The library defaults assume `.rp-set-page` is a standalone scroll
container (`height: 85dvh; overflow-y: auto`) and `.rp-card` is a
40%-tinted-over0 glass surface. For this 2-step composition we want:

```css
/* Single outer scroll surface — .home-steps. Cards grow to content. */
#page-profile .hs-card {
  height: auto; min-height: 100svh;
  align-items: stretch; justify-content: flex-start;
  padding-top: 4rem; padding-bottom: 4rem;
}
#page-profile .rp-set-page {
  width: 90%; max-width: none;
  height: auto; overflow: visible;
  margin: 0 auto; padding: 0;
}

/* High-contrast frosted-glass cards (matches the corner float buttons
   in the redpash-app: 10% white tint + 18% white border + 0.75rem
   backdrop blur + soft shadow). */
#page-profile .rp-card {
  background: rgba(255, 255, 255, 0.10);
  border: 0.0938rem solid rgba(255, 255, 255, 0.18);
  backdrop-filter: blur(0.75rem);
  -webkit-backdrop-filter: blur(0.75rem);
  box-shadow: 0 0.125rem 1rem rgba(0, 0, 0, 0.2);
}
html[data-theme="light"] #page-profile .rp-card {
  background: rgba(255, 255, 255, 0.5);
  border-color: rgba(30, 30, 46, 0.12);
}
/* Danger card — same body, red border. */
#page-profile .rp-card--danger {
  border-color: color-mix(in srgb, var(--red) 45%, rgba(255, 255, 255, 0.18));
}
```

The `.rp-stat-strip` Usage row inherits the library's own glass
recipe so the row, the plan card, the security card, and the
connected-accounts card all read as one glass family.

---

## Bespoke (page-specific) markup blocks

A few structures aren't in the library and live in `profile.html` +
`profile.css`:

- **`.rp-profile__plan` / `.rp-profile__plan-top` /
  `.rp-profile__plan-features`** — the plan card body: name + sub +
  upgrade button on top, checked feature list below.
- **`.rp-profile__conn`** — row layout for connected accounts
  (Google / Microsoft / Apple / Facebook) with a brand-colored icon,
  name, detail, and state pill on the right.
- **`.rp-profile__edit-toggle`** — the pencil button in the identity
  row (see "Edit-mode lock" below). Active state pulls the accent
  through the frosted-glass shell.
- **`.rp-profile__rid`** — monospace styling for the Account ID
  readonly input.
- **`.rp-avatar-edit`** — the small camera overlay button positioned
  bottom-right on the avatar.

Usage shows up as a **library `.rp-stat-strip`** row (4 cells:
Projects · Files · Reports · Dashboards). Each cell is a `<button>`
that navigates back to `#/home` with `sessionStorage["home-step"]`
pre-set to the matching step.

---

## Avatar size

`#profile-avatar.rp-avatar--xl` is bumped to **4rem narrow / 4.5rem
desktop** (the library `--xl` default is 3.75rem) so the user's
"you mark" stays the same scale as the home page's `#home-avatar`.
Photo or initials behavior is otherwise identical to home.

---

## Personal info — aligned with `UserProfile` DTO

| Field | Edit | Source | Notes |
|---|---|---|---|
| `avatar_url` | indirect | Google `picture` claim | Camera overlay → stubbed upload (Phase 6). |
| `display_name` | ✅ | text input | PATCHed. |
| `username` | — | text input (readonly) | Server-assigned (`{email-local}.{rid-suffix}` for OAuth). |
| `email` | — | text input (readonly) | From Google. |
| `job_title` | ✅ | text input | PATCHed. |
| `organisation` | ✅ | text input | PATCHed. |
| `use_case` | ✅ | `.rp-set-opt-grp` pill group | One of: operational / research / reporting / other. PATCHed. |
| `redpash_id` | — | text input (readonly, monospace) | Copy-to-clipboard button via `profileCopyId()`. |
| `plan` | — | green pill in identity header | Read-only; values: free / trial / pro. |
| `locale` | — | — | Lives on **step 2** (Appearance → Language), not in Personal info. |
| `prefs` | — | — | Lives in Settings step; profile doesn't touch it. |

Single `PATCH /api/me` on form submit sends only the four editable
fields. Library's `.rp-set-input` recipe (translucent dark / cream
light + accent focus ring + muted readonly variant) renders both
states cleanly — the recipe was promoted upstream into
`redpash-components/components/settings-card.css` so every future
settings/profile-style page gets it automatically.

### Edit-mode lock

Personal-info fields are **read-only by default**. Two circular
glass `.rp-float-btn`s sit on the right side of the identity row:

- **Edit toggle** (`#profile-edit-toggle`, `.rp-profile__edit-toggle`,
  pencil icon) — flips the form's `.is-editing` class via
  `setEditMode(root, editing)` in `profile.js`. Active state pulls
  the accent through the glass shell (accent border + 35%-accent
  tint + accent-tinted glow shadow) so the editing state is
  unmistakable; `aria-pressed` flips to `true`.
- **Save** (`#profile-save-btn`, floppy icon) — disabled
  (`opacity: 0.35; cursor: not-allowed; pointer-events: none`) while
  the form is locked. Re-enabled when the pencil is active.

`setEditMode(root, editing)` toggles three things together:

1. `input[name]` elements (the four editable fields) get their
   `readOnly` property flipped. Permanent-readonly inputs (username /
   email / Account ID) have no `name` and are skipped, so they stay
   muted at all times.
2. The use-case `.rp-set-opt-grp` gets `pointer-events: none;
   opacity: 0.55` when locked so its pill buttons can't be clicked.
3. The Save button enables / disables.

On `PATCH /api/me` success the form re-locks (`setEditMode(root,
false)`) so the user can verify the saved state without sitting in a
"live" form. On failure the form stays editable and the Save button
re-enables.

---

## Step 2 — Settings

**Left col — Appearance**:

- **Theme** — `.rp-theme-sw` with three `.rp-theme-btn`s
  (`light` / `system` / `dark`). Click calls
  `rpSetTheme(t)` (owned by `main.js` shell) which sets
  `<html data-theme>`, animates the icon swap (spin-out → swap
  bi-sun-fill ↔ bi-moon-fill → spin-in), and persists to
  `localStorage["redpash-theme"]`. A `MutationObserver` re-syncs the
  `.active` state when the user uses the float-bar toggle instead of
  the 3-state switch. Each button carries a `data-theme` attribute
  and the **active state pulls a matching color** — Light = `var(--yellow)`,
  System = `var(--accent)`, Dark = `var(--purple)`. This per-theme
  color mapping was promoted upstream into
  `redpash-components/components/theme-toggle.css` so every consumer
  picks it up.
- **Topbar position** — `.rp-set-opt-grp` (id `settings-topbar-pos`)
  with three `.rp-set-opt`s carrying `bi-align-start` / `bi-align-center`
  / `bi-align-end` icons + L / C / R labels. Dispatches to
  `window.rpSetBarPos("top", "l" | "c" | "r")` (owned by `main.js`),
  which moves every `.rp-float-bar--top*` to the chosen anchor and
  persists to `localStorage["rp-topbar-pos"]`. Restored on every
  navigation via `window.rpRestoreBarPositions()` so the choice
  survives across pages.
- **Footer position** — same shape, id `settings-footer-pos`,
  dispatches to `window.rpSetBarPos("bottom", …)`, persists to
  `localStorage["rp-bottombar-pos"]`. The library now ships all 6
  anchor classes (`tl / tc / tr / bl / bc / br`) — the missing
  top-center / bottom-center variants (`--tc` / `--bc`) were promoted
  upstream into `redpash-components/components/float-btn.css` so
  this picker exposes the full 3×2 grid.
- **Language** — `.rp-set-opt-grp` with EN / FR active pills + zh /
  ru / sw "Soon" stubs. Writes to `localStorage["redpash-lang"]`;
  doesn't yet PATCH `/api/me`. The landing page's translation table
  reads this key on next mount.

**Right col — Data & Export**:

A small `PREF_GROUPS` table in `profile.js` drives **all three rows**:
each entry pairs a `data-prefs="…"` group with a `localStorage` key
and a default. On mount it restores the saved value; on click it
flips the `.active` pill and writes through.

- **Default CSV delimiter** — pill group: auto-detect / comma /
  semicolon / tab. Persisted to `localStorage["rp-default-delimiter"]`.
  Not yet read by the cleaner sidebar (that still auto-detects
  per-file) — the persistence layer is in place for the upcoming
  "use my default" wiring.
- **Default encoding** — pill group with **9 codecs matching the
  cleaner sidebar detector** (`scripts/cleaner/tools/encoding.js`):
  auto-detect / `utf-8` / `utf-16le` / `utf-16be` / `windows-1252` /
  `iso-8859-1` / `iso-8859-15` / `windows-1250` / `macintosh`.
  Persisted to `localStorage["rp-default-encoding"]`.
- **Export format** — CSV / Excel (`xlsx`) / JSON, **all three
  clickable** (the `.rp-set-opt--soon` lock was removed once the
  CSV → XLSX / JSON server-side path was confirmed trivial via the
  existing Polars writers). Persisted to
  `localStorage["rp-export-format"]`. Read by the cleaner / report
  export buttons on next mount.

The Usage stat-strip on Step 1 already deep-links into individual
home steps via `sessionStorage["home-step"]`, so a separate "Account"
jump card on Step 2 was redundant and was removed.

**Full-width About card** — Wordmark + version + Docs / Vision /
Getting-started links.

---

## Float bars + step-dots

**Top-right** — Theme toggle (`rpToggleTheme`) + Log out (`doLogout`).

**Bottom-left** — Home (`#/home`) · Docs (`#/docs`) · Contact
(`openModal('contact')`). The redundant Projects / Files buttons
were removed once the Usage stat-strip on Step 1 picked up the same
deep-link role via `sessionStorage["home-step"]`.

**Right step-dots** — 2 dots (`bi-person-fill` + `bi-gear-fill`).
Revealed via `body:has(#page-profile) .rp-page-dots { display: flex }`
in `profile.css`. IntersectionObserver in JS toggles `.active`.

---

## JS wiring (inline `onclick` handlers)

| Handler | Source | Behavior |
|---|---|---|
| `profileGoTo(step)` | profile.js | Smooth scroll to `.hs-card[data-step="step"]`. |
| `profilePhotoSelected(input)` | profile.js | Stub — toasts. No `/api/me/avatar` endpoint yet. |
| `profileUpgrade()` | profile.js | Stub — Phase 6 (Stripe). |
| `profileDelete()` | profile.js | Stub — Phase 4c+. |
| `profileCopyId()` | profile.js | `navigator.clipboard.writeText(redpash_id)` + success toast. |
| `profileToggleEdit()` | profile.js | Flip the edit-mode lock — see "Edit-mode lock" above. |
| `doLogout()` | profile.js (defensive) / **main.js** (canonical) | `POST /api/auth/logout` + redirect to `#/landing`. |
| `doContact()` | profile.js (defensive) | Stub — no `/api/contact` endpoint yet. |
| `openModal('contact')` / `closeModal('contact')` | **main.js** (shell) | Modal toggle. |
| `rpToggleTheme()` / `rpSetTheme(t)` | **main.js** (shell) | Theme cycle with icon spin + localStorage persist. |
| `rpSetBarPos(rail, pos)` / `rpRestoreBarPositions()` | **main.js** (shell) | Move every float bar on `rail` (`"top"` / `"bottom"`) to anchor `pos` (`"l"` / `"c"` / `"r"`). Persists per-rail to `localStorage`. Restored on every nav. Wired here by `wirePosPicker("#settings-topbar-pos", "top", "r")` + `wirePosPicker("#settings-footer-pos", "bottom", "l")` in `profile.js`. |
| `PREF_GROUPS` restore + click handler | profile.js | Restores delimiter / encoding / export-format pill `.active` state from `localStorage` on mount; writes through on click. |

---

## Wired vs stubbed against the backend

| Surface | Endpoint | Status |
|---|---|---|
| Profile identity header (avatar / name / email / plan) | `GET /api/me` | ✅ live |
| Editable fields save | `PATCH /api/me` | ✅ live (display_name / job_title / organisation / use_case) |
| Usage: Projects | `GET /api/projects` `.items.length` | ✅ live |
| Usage: Files | `Σ project.file_count` | ✅ live |
| Usage: Reports | `GET /api/reports` `.items.length` | ✅ live |
| Usage: Dashboards | `GET /api/dashboards` `.items.length` | ✅ live |
| Connected: Google | `me.email` present → Connected pill | ✅ live |
| Connected: Microsoft / Apple / Facebook | — | ⛔ stub (Soon) |
| Theme cycle | `localStorage["redpash-theme"]` | ✅ live (no backend; Settings page will PATCH `prefs.theme` later) |
| Topbar position | `localStorage["rp-topbar-pos"]` + `window.rpSetBarPos` | ✅ live; restored on every nav via `rpRestoreBarPositions()` |
| Footer position | `localStorage["rp-bottombar-pos"]` + `window.rpSetBarPos` | ✅ live; restored on every nav |
| Language pills | `localStorage["redpash-lang"]` | ✅ live; doesn't yet PATCH `prefs.locale` |
| Default CSV delimiter | `localStorage["rp-default-delimiter"]` | 🟡 persisted; not yet read by cleaner sidebar |
| Default encoding | `localStorage["rp-default-encoding"]` | 🟡 persisted; not yet read by cleaner sidebar |
| Export format | `localStorage["rp-export-format"]` | 🟡 persisted; not yet read by export buttons |
| Avatar upload | — | ⛔ stub (Phase 6) |
| Password change | — | ⛔ stub (OAuth-only — no password to manage) |
| Two-factor auth | — | ⛔ stub (Soon) |
| Active sessions | — | ⛔ stub (Soon) |
| Plan upgrade | — | ⛔ stub (Phase 6 — Stripe) |
| Billing email / invoices | — | ⛔ stub |
| Delete account | — | ⛔ stub (Phase 4c+) |
| Log out | `POST /api/auth/logout` | ✅ live |

---

## Naming convention vs library

| Class | Owned by |
|---|---|
| `.rp-set-*` / `.rp-card` / `.rp-card--danger` / `.rp-soon` / `.rp-theme-*` / `.rp-set-acct-row` / `.rp-set-about*` / `.rp-set-opt*` / `.rp-set-input*` / `.rp-set-fbar` | Library (`components/settings-card.css`) |
| `.rp-avatar*` / `.rp-page-dots` / `.rp-page-dot` / `.rp-float-bar` / `.rp-float-btn` / `.rp-float-label` / `.hs-card` / `.hs-import` / `.hs-report` / `.home-steps` / `.modal-overlay` / `.modal` / `.rp-modal--glass` / `.btn` / `.btn-primary` / `.form-*` / `.rp-wordmark` / `.rp-r` | Library |
| `.rp-profile__plan*` / `.rp-profile__conn*` / `.rp-profile__rid` / `.rp-profile__edit-toggle` / `.rp-avatar-edit` (positioning) | This page (bespoke — promote to library if a second consumer appears) |
| `.rp-stat-strip` / `.rp-stat` / `.rp-stat-val` / `.rp-stat-lbl` | Library (`components/stat-strip.css`) — Usage row |
| `.rp-app` / `.rp-topbar*` / `.rp-btn` / `.rp-modal` / `.rp-field` | App (`frontend/styles/components/`) — none used on this page since the topbar is hidden and forms use library `.rp-set-input` |

No collisions on the profile page.

---

## Visual differences vs the Django reference

The Django `/profile` (single column on phones, two columns wide) and
`/settings` (similar) are **separate flat pages** in the Django app.
The redpash-app **consolidates them into one full-bleed scroll-snap
page** so the user can flow from profile fields → settings without
navigating away. The float bars carry the cross-page nav the Django
sidebar used to do.

Color treatment also differs:

- Django: solid surface cards on the app's red brand.
- redpash-app: frosted-glass cards on catppuccin-blue / catppuccin-
  purple gradient step backgrounds (matches the home page family;
  `body[data-chrome="full"]` rebinds `--accent` from RedPash red to
  library blue so library components render in their intended palette).

---

## Cache / refresh

Every change to the partial, CSS, JS, or any imported library
component triggers a `service-worker.js` `CACHE_VERSION` bump. Hard-
refresh after edits.
