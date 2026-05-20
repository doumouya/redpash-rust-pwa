---
title: Profile + Settings page (`#/profile`)
section: Frontend
order: 13
last modified date: 2026-05-20
---

# Profile + Settings page (`#/profile`)

Full-bleed sandbox-chrome page composing the redpash-components
library. The page is a **topbar + `.rp-rt-panel` with a left-rail
section index and a right-pane scrolling column of glass cards** —
mirrors the cleaner / objects / reports chrome family. Profile and
Settings content live as 11 sections in the same scrolling pane,
linked via plain `href="#section-…"` anchors. No step machinery, no
IntersectionObserver — the active rail item is driven by CSS
`:has(:target)`.

The previous design (`hs-card` two-step scroll-snap, mirroring
`redpash-demo`'s `#page-home`) is preserved as
[`partials/profile.live.html`](../../../../frontend/partials/profile.live.html) +
[`styles/pages/profile.live.css`](../../../../frontend/styles/pages/profile.live.css)
for reference. Same JS bindings (`id="profile-*"` / `id="settings-*"`
hooks) — `profile.js` continues to drive both versions without
modification.

`/settings` is still a separate route today for direct linking; it
falls through to the old minimal page. The intent over time is to
have it scroll into the matching `#section-…` of `/profile`
automatically.

---

## Files

| File | Role |
|---|---|
| [`partials/profile.html`](../../../../frontend/partials/profile.html) | Markup. Topbar (back to objects + page title + profile/docs/theme cluster) → `.rp-rt-panel` containing `.rp-profile__layout` = left `.rp-profile__rail` (11 anchor links + Docs/Contact footer) + right `.rp-profile__pane` (11 stacked `<section id="section-…">`). Contact modal at the end. |
| [`styles/pages/profile.css`](../../../../frontend/styles/pages/profile.css) | Page-only layout: topbar reset, rail (sticky/scrollable section index with `:target`-driven active state), pane (scroll container), section card (frosted-glass surface), stat strip / plan card / connected accounts / theme switcher / avatar / about / glass-button hover tweaks. Library `@import`s (typography / button / form / card / modal / settings-card / stat-strip / theme-toggle / avatar / badge). |
| [`scripts/pages/profile.js`](../../../../frontend/scripts/pages/profile.js) | Load `/me` + counts, populate identity + form + connections + settings rows. Inline-onclick globals. Same handlers as the live snapshot. No scroll-snap / IntersectionObserver needed any more — section visibility is native `href="#section-…"` scroll-jump. |
| [`scripts/main.js`](../../../../frontend/scripts/main.js) (shell) | Route flagged `chrome: "full"` → main.css hides topbar, zeroes `.rp-app` gutter, applies the slate-cobalt token palette (`--bg`/`--surface`/`--text`/`--accent`/… bound under `body[data-chrome="full"]`), and sets the page-bg gradient via `var(--rp-bg-app)`. |

---

## Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  ←  ▤ Profile                          👤  📖  🌗                   │  rp-rt-topbar
├──────────────────┬──────────────────────────────────────────────────┤
│ ⏵ Personal info  │  ┌──────────────────────────────────────────┐    │
│   Usage          │  │  Personal info                           │    │
│   Plan & Billing │  │  ─────────────────                       │    │
│   Connected      │  │  [avatar] Display name · Email · Plan    │    │
│   Security       │  │  Display name [_________]                │    │
│   Appearance     │  │  Username     [_________] (readonly)     │    │
│   Objects page   │  │  …                                       │    │
│   Data & Export  │  └──────────────────────────────────────────┘    │
│   Cleaner page   │                                                  │
│   About          │  ┌──────────────────────────────────────────┐    │
│ ⚠ Danger zone    │  │  Usage                                   │    │
│ ─                │  │  ─────────                               │    │
│   📖 Docs        │  │  [stat strip: projects · files · …]      │    │
│   ✉ Contact      │  └──────────────────────────────────────────┘    │
│                  │                                                  │
│  rp-profile__    │  rp-profile__pane                                │
│  rail            │  (scrollable; sections are anchor targets)       │
└──────────────────┴──────────────────────────────────────────────────┘
```

**Topbar** — back arrow → `#/objects`, magic-icon page title
("Profile"), profile/docs/theme cluster on the right. Same recipe as
cleaner / objects / reports.

**Left rail** (`.rp-profile__rail`) — 11 `<a class="rp-profile__rail-link" href="#section-…">`
links + a `.rp-profile__rail-foot` with two `--muted` items (Docs link +
Contact button that triggers `openModal('contact')`). The danger zone
link carries `--danger` modifier so its active/hover states pull red
instead of accent.

Active highlighting is **pure CSS** — `.rp-profile__rail-link:has(href="#section-…")`
matched against `body:has(:target)` lights the right item. No JS
sync needed; clicking a rail link sets `:target` natively. The
sticky positioning keeps the rail in view as the right pane scrolls.

**Right pane** (`.rp-profile__pane`) — single scroll surface. Each
`<section id="section-…">` is a `.rp-profile__section` containing a
`.rp-profile__section-hdr` (h2 + sub) and a `.rp-profile__card` body.
Sections appear in rail order.

---

## The 11 sections

| Section id | Rail icon | Content |
|---|---|---|
| `personal` | `bi-person` | Personal info form (avatar, display name, username, email, job title, organisation, use case). Identity row + edit-mode lock — see below. |
| `usage` | `bi-bar-chart` | `.rp-stat-strip` (4 tiles: Projects · Files · Reports · Dashboards), each a button that deep-links into `/objects?tab=…`. |
| `plan` | `bi-rocket-takeoff` | Plan & billing — name + sub + upgrade button + checked feature list (`.rp-profile__plan*`). |
| `connected` | `bi-link-45deg` | Connected accounts — Google (live) / Microsoft / Apple / Facebook (stub) row layout (`.rp-profile__conn`). |
| `security` | `bi-shield-lock` | Password change (stub — OAuth-only), 2FA (stub), active sessions (stub). |
| `appearance` | `bi-palette` | Theme switcher (`.rp-theme-sw`), topbar position picker, footer position picker, language pills. |
| `objects` | `bi-grid-3x3-gap` | Objects-page settings (saved tab views, default sort, etc.). |
| `data` | `bi-database` | Data & Export — default CSV delimiter / encoding / export format pill groups. |
| `cleaner` | `bi-magic` | Cleaner-page settings (saved filter views, default tools panel, …). |
| `about` | `bi-info-circle` | Wordmark + version + Docs / Vision / Getting-started links. |
| `danger` | `bi-exclamation-triangle` | Log out + Delete account. Card border is `var(--red)`-tinted; rail link uses `--danger` modifier. |

Each section uses the same `.rp-set-*` class family the live snapshot
used (forms, rows, dividers, labels, inputs, pill groups) so the
existing `profile.js` data-binding code (`id="profile-*"` /
`id="settings-*"` hooks) works without changes.

---

## Library components composed

```css
@import "/styles/base/typography.css";
@import "/styles/components/button.css";
@import "/styles/components/form.css";
@import "/styles/components/card.css";
@import "/styles/components/modal-sandbox.css";
@import "/styles/components/auth-modals.css";
@import "/styles/components/avatar.css";
@import "/styles/components/theme-toggle.css";
@import "/styles/components/badge.css";
@import "/styles/components/stat-strip.css";
@import "/styles/components/settings-card.css";
```

`tokens.css`, `reset.css`, `glass-btn.css` (`.rp-btn` base), and
`modals-sandbox.css` (`.rp-modal` base) are loaded globally via
[`main.css`](../../../../frontend/styles/main.css). The full-bleed
body chrome (no topbar / flex column / hidden overflow) + the
slate-cobalt token palette also live there, keyed off
`body[data-chrome="full"]`. This page no longer needs the per-page
`@import shell.css` or `@import glass-btn.css` it used to carry. See
[design.md](../../design.md) for the layering discipline.

The `settings-card.css` component holds every "settings page primitive"
the page uses: `.rp-set-row` / `.rp-set-lbl` / `.rp-set-title` /
`.rp-set-sub` / `.rp-set-divider` / `.rp-set-input` / `.rp-set-input-wrap` /
`.rp-set-opt-grp` / `.rp-set-opt` / `.rp-set-opt--soon` / `.rp-soon` /
`.rp-set-acct-row` / `.rp-set-about` / `.rp-set-about-links` /
`.rp-theme-sw` / `.rp-theme-btn`. Live snapshot's `.rp-set-page` /
`.rp-set-grid` / `.rp-set-col` / `.rp-set-sh` scaffolding is **gone** —
the rail + pane layout replaces it.

---

## Page-specific BEM (`.rp-profile__*`)

Bespoke classes in `profile.html` + `profile.css`:

- **`.rp-profile__layout`** — flex row, left rail + right pane.
- **`.rp-profile__rail`** — sticky vertical nav, ~14rem wide, holds the
  11 section links. `:has(:target)` drives the active state.
- **`.rp-profile__rail-link`** — anchor inside the rail (icon +
  label). Hover pulls a soft accent wash; active (`:has(:target)`)
  paints a slim accent bar on the left + bumps the bg to a stronger
  accent tint. `--danger` variant flips to red for the danger-zone
  link; `--muted` variant softens the docs/contact footer items.
- **`.rp-profile__rail-foot`** — bottom-pinned cluster inside the rail
  for the Docs link + Contact button.
- **`.rp-profile__pane`** — the right column, single scroll surface.
- **`.rp-profile__section`** — block-level anchor target. Each one is
  ~24rem-min-width and grows to its content.
- **`.rp-profile__section-hdr`** — h2 + sub headline above each card.
- **`.rp-profile__section-ttl`** / **`.rp-profile__section-sub`** —
  type styles for the section header.
- **`.rp-profile__card`** — frosted-glass body (matches the cleaner /
  objects panel chrome; 10% white tint dark / 50% white tint light, 18%
  white border, 0.75rem backdrop blur, soft shadow). The legacy
  `.rp-card` from `settings-card.css` is no longer used here.
- **`.rp-profile__section--danger`** — section variant: the card border
  is `var(--red)`-tinted.
- **`.rp-profile__plan*`** / **`.rp-profile__conn*`** / **`.rp-profile__rid`** /
  **`.rp-profile__edit-toggle`** / **`.rp-avatar-edit`** — section-internal
  bits carried over from the live snapshot (plan-card body, connected-
  account row, monospace Account ID, identity-row pencil button, avatar
  camera overlay). Promote to library if a second consumer appears.

The `.rp-stat-strip` Usage row inherits the library's own glass recipe
so the row and the surrounding glass cards all read as one family.

---

## Avatar size

`#profile-avatar.rp-avatar--xl` is bumped to **4rem narrow / 4.5rem
desktop** (the library `--xl` default is 3.75rem) so the user's
"you mark" stays the same scale as the home page's `#home-avatar`.
Photo or initials behaviour is otherwise identical to home.

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
| `locale` | — | — | Lives in the Appearance section (Language), not in Personal info. |
| `prefs` | — | — | Lives in the Data & Export / Cleaner / Objects sections; Personal info doesn't touch them. |

Single `PATCH /api/me` on form submit sends only the four editable
fields. Library's `.rp-set-input` recipe (translucent dark / cream
light + accent focus ring + muted readonly variant) renders both
states cleanly.

### Edit-mode lock

Personal-info fields are **read-only by default**. Two circular
glass `.rp-btn`s sit on the right side of the identity row:

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

## Appearance section

**Theme** — `.rp-theme-sw` with three `.rp-theme-btn`s
(`light` / `system` / `dark`). Click calls `rpSetTheme(t)` (owned by
`main.js` shell) which sets `<html data-theme>`, animates the icon
swap (spin-out → swap bi-sun-fill ↔ bi-moon-fill → spin-in), and
persists to `localStorage["redpash-theme"]`. A `MutationObserver`
re-syncs the `.active` state when the user uses the topbar toggle
instead of the 3-state switch. Each button carries a `data-theme`
attribute and the **active state pulls a matching color** — Light =
`var(--yellow)`, System = `var(--accent)`, Dark = `var(--purple)`.
This per-theme color mapping lives in
`redpash-components/components/theme-toggle.css` so every consumer
picks it up.

**Topbar position** — `.rp-set-opt-grp` (id `settings-topbar-pos`)
with three `.rp-set-opt`s carrying `bi-align-start` / `bi-align-center`
/ `bi-align-end` icons + L / C / R labels. Dispatches to
`window.rpSetBarPos("top", "l" | "c" | "r")` (owned by `main.js`),
which moves every `.rp-float-bar--top*` to the chosen anchor and
persists to `localStorage["rp-topbar-pos"]`. Restored on every
navigation via `window.rpRestoreBarPositions()` so the choice
survives across pages.

**Footer position** — same shape, id `settings-footer-pos`, dispatches
to `window.rpSetBarPos("bottom", …)`, persists to
`localStorage["rp-bottombar-pos"]`. The library ships all 6 anchor
classes (`tl / tc / tr / bl / bc / br`).

**Language** — `.rp-set-opt-grp` with EN / FR active pills + zh / ru /
sw "Soon" stubs. Writes to `localStorage["redpash-lang"]`; doesn't
yet PATCH `/api/me`. The landing page's translation table reads this
key on next mount.

---

## Data & Export section

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
  clickable**. Persisted to `localStorage["rp-export-format"]`. Read
  by the cleaner / report export buttons on next mount.

---

## JS wiring (inline `onclick` handlers)

| Handler | Source | Behavior |
|---|---|---|
| `profilePhotoSelected(input)` | profile.js | Stub — toasts. No `/api/me/avatar` endpoint yet. |
| `profileUpgrade()` | profile.js | Stub — Phase 6 (Stripe). |
| `profileDelete()` | profile.js | Stub — Phase 4c+. |
| `profileCopyId()` | profile.js | `navigator.clipboard.writeText(redpash_id)` + success toast. |
| `profileToggleEdit()` | profile.js | Flip the edit-mode lock — see *Edit-mode lock* above. |
| `doLogout()` | profile.js (defensive) / **main.js** (canonical) | `POST /api/auth/logout` + redirect to `#/landing`. |
| `doContact()` | profile.js (defensive) | Stub — no `/api/contact` endpoint yet. |
| `openModal('contact')` / `closeModal('contact')` | **main.js** (shell) | Modal toggle. |
| `rpToggleTheme()` / `rpSetTheme(t)` | **main.js** (shell) | Theme cycle with icon spin + localStorage persist. |
| `rpSetBarPos(rail, pos)` / `rpRestoreBarPositions()` | **main.js** (shell) | Move every float bar on `rail` (`"top"` / `"bottom"`) to anchor `pos` (`"l"` / `"c"` / `"r"`). Persists per-rail to `localStorage`. Restored on every nav. Wired here by `wirePosPicker("#settings-topbar-pos", "top", "r")` + `wirePosPicker("#settings-footer-pos", "bottom", "l")` in `profile.js`. |
| `PREF_GROUPS` restore + click handler | profile.js | Restores delimiter / encoding / export-format pill `.active` state from `localStorage` on mount; writes through on click. |

The previous `profileGoTo(step)` helper (smooth-scroll between the
two `.hs-card` steps) is **gone**. Section anchors use native
`href="#section-…"` instead — the browser handles the scroll.

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
| Theme cycle | `localStorage["redpash-theme"]` | ✅ live (no backend; Settings will PATCH `prefs.theme` later) |
| Topbar position | `localStorage["rp-topbar-pos"]` + `window.rpSetBarPos` | ✅ live; restored on every nav |
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
| `.rp-set-*` / `.rp-soon` / `.rp-theme-*` / `.rp-set-acct-row` / `.rp-set-about*` / `.rp-set-opt*` / `.rp-set-input*` | Library (`components/settings-card.css`) |
| `.rp-stat-strip` / `.rp-stat` / `.rp-stat-val` / `.rp-stat-lbl` | Library (`components/stat-strip.css`) — Usage row |
| `.rp-rt-topbar` / `.rp-rt-panel` / `.rp-rt-page-title` | Library / app `main.css` — shared sandbox chrome family |
| `.rp-btn` / `.rp-modal*` / `.modal` / `.btn` / `.form-*` / `.rp-avatar*` / `.rp-wordmark` / `.rp-r` | Library (loaded globally via `main.css`) |
| `.rp-profile__layout` / `.rp-profile__rail*` / `.rp-profile__pane` / `.rp-profile__section*` / `.rp-profile__card` / `.rp-profile__plan*` / `.rp-profile__conn*` / `.rp-profile__rid` / `.rp-profile__edit-toggle` / `.rp-avatar-edit` (positioning) | This page (bespoke — promote to library if a second consumer appears) |
| `.rp-app` / `.rp-topbar*` / `.rp-btn--primary/--ghost/--danger/--sm` / `.rp-field` | App (`frontend/styles/components/`) — none used on this page since the topbar is hidden and forms use library `.rp-set-input` |

No collisions on the profile page.

---

## Visual differences vs the Django reference / live snapshot

The Django `/profile` (single column on phones, two columns wide) and
`/settings` (similar) are **separate flat pages** in the Django app.
The live snapshot version (`profile.live.html`) consolidated them
into a 2-step scroll-snap matching the home-page family.

The current version drops the scroll-snap in favour of the
**topbar + rail + pane** sandbox chrome shared with cleaner /
objects / reports — same family across every authenticated tool
surface, easier to scan when scrolling 11 sections. The trade-off is
losing the per-step gradient backdrop (each `.hs-card` had its own
hero gradient); the slate-cobalt palette + frosted-glass cards keep
the visual weight via card translucency instead.

Color treatment:

- Django: solid surface cards on the app's red brand.
- redpash-app (this version): frosted-glass cards on the slate-cobalt
  / Arctic-blue palette shared by every full-bleed sandbox page.
  `body[data-chrome="full"]` rebinds `--accent` from RedPash red to
  cobalt blue (`#60a5fa` dark / `#2563eb` light) so library-composed
  surfaces render in the sandbox palette; the RedPash red is reserved
  for the wordmark / `.rp-r` brand badge.

---

## Cache / refresh

Every change to the partial, CSS, JS, or any imported library
component triggers a `service-worker.js` `CACHE_VERSION` bump. Hard-
refresh after edits.
