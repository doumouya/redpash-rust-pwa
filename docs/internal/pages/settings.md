---
title: Page — Settings
section: Internal
last modified date: 2026-06-07
---

# Page — Settings

## Purpose

**The one place a user shapes how the whole app behaves for them.** Theme,
density, font size, per-surface table defaults, Cleaner sentinels, Cases-page
defaults, per-tab chart layouts, and recovery of anything they've hidden —
all read from and written to the same per-user preference object.

The page is deliberately **not a hand-written form**. It renders itself by
iterating the **open pref registry** in `prefs.js`. A pref becomes a Settings
row by being registered with the right UI fields; the page never needs editing
to gain a control. This is [[data-format-open-ended]] applied to the settings
surface: there is no enumerated `SETTINGS_ROWS` tree to drift out of sync with
what's actually stored.

## How it renders — registry-driven, not template-driven

`settings()` (the page entry) does, in order:

1. `renderFromRegistry(app)` — `eachPref()` walks every registered spec.
   Specs without a `section` don't surface (they're behavioral-only, e.g.
   `workspace-railView`, `cases-filterAssignee`). For each surfacing spec it
   looks up `spec.control` in the **CONTROLS dispatch map**, calls that
   module's `render(spec) → htmlString`, and buckets the HTML by section.
   Section **EXTRAS** (rows not backed by a registered pref — sentinels list,
   share toggle, account fields, About brand) are appended **after** the
   registered rows for their section. Each section's combined HTML is mounted
   into its `[data-rp-rows="<key>"]` slot (a small `SECTION_MOUNT_KEY` map
   bridges the rail's `set-<key>` ids to the partial's short slot keys).
2. `mountSettingsRail(app)` — builds the grouped left rail.
3. `mountSearch(app)` — behavior-first search over the rendered rows (must run
   after the rail, since it indexes the per-group hit-count badges).
4. Account section paint (read-only from `session`), sign-out wiring.
5. `/me` fetch for **server-side** prefs (sentinels + share toggle), then
   initial `is-active` paint of every option group.
6. One delegated click handler drives **every** option group.
7. `callPostMountHooks(app)` — controls that paint imperatively after their row
   HTML lands (today: `chart-layouts`).
8. `mountHidden(app)` — the Hidden Items recovery surface.

**Adding a control type** = import the renderer module and add one line to the
CONTROLS map. The renderer is a `{ render(spec), postMount?(app, spec) }`
module — the same shape `chart-layouts` and `theme-swatch` follow, so any
future deferred-mount control plugs in identically.

### The CONTROLS dispatch

- `onoff` / `segmented` → `prefRow()` from `page-row.js` (a label/hint plus a
  button group; `data-value` per button). Most prefs use this — the "onoff"
  name is historical, it renders any small enum as a segmented button row.
- `stepper` → the **A− / A+** font-size affordance, not an sm/md/lg toggle
  (Em: "everyone can pick a size, HiDPI or not"). `data-step` keeps its buttons
  off the absolute-value click delegation; it drives itself via its `postMount`
  hook, stepping through the spec's `values` and disabling at the ends.
- `theme-swatch` → the live preview-card grid (see below).
- `chart-layouts` → the per-tab chart picker for Monitoring/Home, painted in
  `postMount` after its row mounts.

## The rail — page-grouped, tab-switch

Five groups (`SET_GROUPS`): **GENERAL / HOME / WORKSPACE / CASES / MONITORING**,
each with a two-letter color mark, mirroring the canonical Home/Monitoring rail
shape. This is a **page-bucketed** layout (CAS_3FC70F56) — regrouped from the
old ability-bucketed one (UI/DATA/CHARTS/ACCOUNT). The section ids (`set-*`)
were preserved through that change so prefs and deep-links survived; only the
rail layout moved.

Tab-switch UX (Em 2026-05-28): clicking a tab shows **one** section and hides
the others (`sec.hidden`), so each tab opens at its head with the full surface
available — no scroll-spy, no IntersectionObserver. The active tab is persisted
in the URL hash (`#/settings?tab=<key>`) via `replaceState`, so a refresh or
shared link lands back on the same tab; an unknown/missing `tab` falls back to
the first tab.

The CASES group's pref rows were absent at first (a stub section) and were
filled by registering case-page prefs as they were identified; the registry-
driven render picks them up with no page edit.

## Theme — the swatch picker

The `general-theme` pref uses the `theme-swatch` control: a grid of **live
per-theme preview cards** (replacing the old dark↔light toggle). The four named
options surfaced as cards are **New Dark** (the app default since 2026-06-07,
the RedPash design-language identity), **New Light**, **Catppuccin Mocha**
(`dark`), and **Catppuccin Latte** (`light`). The spec's `values` enum also
keeps the explicit `catppuccin-*` aliases settable for back-compat.

Theme is the **one special-cased pref** in the page's read/write path: it reads
through `currentTheme()` and writes through `applyTheme()` from `theme.js`
(which swaps `<html data-theme>` and persists), **not** through the generic
`setPref`. Every other registered pref reflects to `<html>` via its spec's
`attr` inside `setPref`, so CSS reacts at paint time with no JS read.

## Prefs storage model (why writes "just work")

Prefs live in the server `user_preferences` table (source of truth) with
localStorage as a **per-key SWR cache** so `getPref` never blocks. Boot seeds
the cache from `/api/me`; every `setPref` writes localStorage + reflects the
`<html>` attr + fires a fire-and-forget `PATCH /api/me/prefs`. A network
failure on that PATCH doesn't fail the user action — the local cache already
landed and the next boot re-syncs.

Two pref classes matter on this page:

- **Registered** prefs validate against an enum (or custom `validate`) and have
  defaults. The click handler resolves the pref via `data-pref`, the button via
  `data-value`, calls `setPref`, and repaints `is-active`. Most values are
  strings.
- **Server-passthrough** prefs (`SERVER_PREF_KEYS = share_sentinels`,
  `learned_sentinels`) come from `/me`, not the local registry. `share_sentinels`
  is a **boolean** — its `data-value` is the string `"true"`/`"false"`, so the
  click handler coerces to an actual boolean before `setPref`, because the
  server's `PATCH /me/prefs` gate keys off `as_bool()`.

**Personal sentinels** (junk placeholder strings the user flagged) render as
removable chips from `prefs.learned_sentinels`. Removal splices the array and
writes back via `setPref`. **Additions never happen here** — they land via the
Cleaner's Fix-invalid-values modal; Settings is remove-only. "Share with all
users" lets a user's sentinels join the global vocabulary after 2+ users flag
the same value (only the placeholder string is shared).

## Hidden Items recovery

The Hidden Items tab (GENERAL group) is a **recovery surface for things hidden
elsewhere**. Pages (Workspace, Home, Cases) declutter by hiding list/rail
entries — written as unregistered `rp-pref-*_hidden_*` localStorage keys.
`mountHidden` scans localStorage for every such key and renders per-page grouped
lists with per-item and per-page restore. The source pages **don't know this
surface exists** — they keep writing the same keys; recovery is decoupled.

The `general-hiddenAutoPurge` pref ("Auto-purge after 30 days") is registered
and renders here, but today it **only persists the toggle state** — the actual
age-based purge needs a per-entry timestamp on the hide-write side, which is a
follow-up. Documented as wire-ready, not yet functional, per
[[build-ready-dont-wire]].

## Account / About / sign-out

Account fields (Display name, Username) are **read-only from the session**, not
prefs. Sign-out POSTs `/auth/logout` (idempotent — the client session is
cleared regardless of the result) then routes to login. About is a structurally
unique branded row (version mount + Docs/Vision/Getting-started links), inlined
rather than parameterized because no second site exists.

## Source files

- [../code/frontend/scripts/pages/settings.md](../code/frontend/scripts/pages/settings.md) — the page entry: registry render, rail, click delegation, sentinels.
- [../code/frontend/scripts/prefs.md](../code/frontend/scripts/prefs.md) — the open pref registry + getPref/setPref + the SWR cache and migration paths.
- [../code/frontend/scripts/theme.md](../code/frontend/scripts/theme.md) — `applyTheme` / `currentTheme`, the special-cased theme read/write.
- [../code/frontend/scripts/prefs/controls/theme-swatch.md](../code/frontend/scripts/prefs/controls/theme-swatch.md) — the live preview-card theme picker control.
- [../code/frontend/scripts/prefs/controls/chart-layouts.md](../code/frontend/scripts/prefs/controls/chart-layouts.md) — the per-tab Monitoring/Home chart-layout picker control.
- [../code/frontend/scripts/pages/settings-hidden.md](../code/frontend/scripts/pages/settings-hidden.md) — the Hidden Items recovery surface (`mountHidden`).
- [../code/frontend/scripts/pages/settings-search.md](../code/frontend/scripts/pages/settings-search.md) — behavior-first search + per-group hit-count badges.
- [../code/frontend/scripts/page-row.md](../code/frontend/scripts/page-row.md) — the `prefRow` / `valueRow` / `actionsRow` / `mountRow` row builders the controls and extras use.
