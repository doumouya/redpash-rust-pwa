---
title: Shared chrome — TopBar
section: Internal
last modified date: 2026-06-07
---

# Shared chrome — TopBar

The TopBar is the single header rendered identically on every authed page. One
component, one button pattern: **brand greeting · OmniSearch · nav · theme ·
sign-out**. A page drops `<header id="rp-topbar"></header>` into its partial and
its script calls `mountTopbar(el, { active, session })`. `active` names which
nav entry is the current page (it gets the `is-active` class); `session` is the
resolved `/api/me` payload. There is exactly one TopBar — no per-page template
branching. That is the whole point: chrome consistency is a property of *not
having a second implementation* to drift against.

## The brand slot is a greeting, not a wordmark

The leftmost slot links to `#/home` but its text is a time-of-day salutation:
`Good morning, <first_name>.` (`first_name`, falling back to `display_name`).
The window of the day is bucketed by local hour — night / morning / afternoon /
evening — so the brand carries a personal note instead of a static "RedPash"
logo. The fallback to the literal `RedPash` matters: on the boot path, the
TopBar can mount *before* `/api/me` resolves, so an unresolved session must
still produce a non-empty brand mark rather than a blank slot.

## Nav is a closed list, admin-gated by data

The nav entries live in one module-level `NAV` array — the closed list of the
app's authed primary surfaces. As shipped today that is **Home · Workspace ·
SheetWise · Cases · Monitoring** (the `pages/index.md` prose still says
Home/Workspace/Cases/Monitoring and predates the SheetWise entry — the code is
the truth). Each entry is an `<a class="rt-btn" href="#/...">` with a Bootstrap
icon; the entry matching `active` gets `is-active`.

Two flags shape how an entry renders:

- **`admin: true`** — the entry is filtered out entirely unless
  `session.is_platform_admin`. Monitoring (system observability + the Admin
  Console surface) is the only admin-gated entry; a member or viewer never sees
  it in the TopBar at all (CAS_274EDF3B). This is *display* gating, not access
  control: the real authority is the route guard in `main.js` (a non-admin
  deep-linking `#/monitoring` is bounced home) and the backend `/monitoring/*` +
  `/admin/*` endpoints. Three layers, all reading the same `is_platform_admin`
  bit, so the UI can never grant access the backend would deny.
- **`parked: true`** — renders as a *disabled* button (an honest "coming soon"
  tooltip) rather than a live link or a broken href. Wiring a parked page on is
  a one-line edit: drop the `parked` flag when the page lands. No other TopBar
  change is needed. (No entry is parked today; the mechanism is the discipline.)

Settings / Docs / Profile used to live here; they moved to the rail footer
(`rail-footer.js`) on 2026-05-28 — the TopBar carries the *primary* surfaces +
theme + sign-out, while the utility destinations live at the bottom of every
railed page's rail. Profile's avatar moved with it.

## Theme toggle shows the current theme

The theme button delegates to `theme.js` (`toggleTheme` / `currentTheme`). The
icon advertises the **current** theme (sun = light, moon-stars = dark), not the
state a click would switch *to*. This keeps it aligned with the Settings page's
Appearance picker, which shows the same icons for the same states — when both
surfaces are on screen, an "advertise what the click does" icon would read
inverted against the picker and confuse the user (Em, 2026-05-28).

## Sign-out is idempotent

The sign-out button POSTs `/auth/logout`, then clears the client session
regardless of the response (navigate to `#/login` and reload). A failed or
already-expired logout call must not strand the user in an authed-looking shell,
so the client-side teardown runs in a `catch` too.

## OmniSearch

The search box (`#rp-omni`, placeholder "Search RedPash …") wires to
`GET /api/search?q=&limit=20`. Notable behaviors:

- **Debounced 200ms** per keystroke; identical consecutive queries are skipped.
- **Out-of-order safety** — each search holds an `AbortController` and aborts
  the prior inflight request, so a slow earlier reply can't overwrite a more
  recent one.
- **Backend-built navigation** — each result ships a ready-made `#/…` hash, so
  the click handler is one line (`location.hash = r.hash`). The frontend does
  not construct routes from result data.
- **Grouped dropdown** — results arrive ordered by `kind`; a single pass emits
  a section header on each kind transition. `kind` drives both the section label
  (explicit plurals — `company → Companies`, not the mangled auto-pluralization)
  and the row icon.
- **Keyboard** — `Ctrl/Cmd+K` focuses the box (bound *once* for the app's life,
  guarded by a module flag, since the TopBar remounts per page). Arrow keys move
  a wrap-around cursor, Enter navigates the highlighted row, Escape closes and
  blurs. Result clicks use `mousedown` (not `click`) so navigation fires before
  the outside-click blur handler can close the dropdown first.

Because the TopBar is remounted on every page navigation, dropdown state resets
naturally — there is no cross-mount lifecycle to manage.

## Source files

- [topbar.js survival doc](../../code/frontend/scripts/topbar.md) — the component itself.
- [theme.js survival doc](../../code/frontend/scripts/theme.md) — `toggleTheme` / `currentTheme` backing the theme button.
- [api.js survival doc](../../code/frontend/scripts/api.md) — the `api.get/post` wrapper used for `/search` and `/auth/logout`.
- [dom.js survival doc](../../code/frontend/scripts/dom.md) — `esc` HTML-escaping used throughout the rendered markup.
- [rail-footer.js survival doc](../../code/frontend/scripts/rail-footer.md) — Settings / Docs / Profile, the utility destinations that moved off the TopBar.
