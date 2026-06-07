---
title: frontend/scripts/framework/app-switcher.js
source: ../../../../../../frontend/scripts/framework/app-switcher.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-07
---

# framework/app-switcher.js — App-switcher (launcher)

## Purpose

The **launcher** — the topbar "My Services" menu that switches between RedPash
apps (Informatica's "My Services" model: switch apps from a central launcher
rather than one flat nav). A topbar grid button (`bi-grid-3x3-gap`) opens an app
menu. It is **pure markup**: it composes the `.rp-menu` atom (toggled by the
global `bindDropdown` delegate in `main.js`) and plain `<a href="#/…">` hash
links (navigation needs no JS). The topbar splices the returned string into its
actions nav — no separate mount/teardown.

It reads the [app registry](apps.md) (`appsFor`) so the **Admin tile only shows
for platform admins** (app = RBAC boundary). The app list comes from `apps.js`,
so adding an app or moving a page is a one-place edit there, not here.

## Public surface

- `appSwitcherHTML({ session, activeAppId })` → the `.rp-menu-wrap` launcher HTML
  string. Each app becomes a `.rp-menu-item` tile (icon + name + a `·`-joined
  page-label subtext); the tile matching `activeAppId` gets `selected` +
  `aria-current="true"`. The trigger is an `.rp-btn-icon` with
  `data-dd="rp-app-switcher"`; the menu is `.rp-menu#rp-app-switcher`.

## How it works

- **Reads `appsFor(session)`** — admin apps are filtered out for non-admins, so
  the menu's contents ARE the RBAC boundary (no separate gate in the topbar).
- **One framework class per element** (class-count rule): the launcher is a
  `data-variant="launcher"` of `.rp-menu` — tile / menu / wrap styling hangs off
  the wrap's `[data-variant="launcher"]` ancestor in CSS, never a second class.
- **All dynamic content is escaped** via `esc()` (app name / icon / page labels).
- **No lifecycle.** The string is spliced into the topbar's nav; the `.rp-menu`
  open/close is handled entirely by the global `bindDropdown` delegate.

## Drift-prone areas

- **App data is not here.** Tiles, order, RBAC, and which pages a tile lists all
  come from [apps.js](apps.md); this file only renders. Adding an app is an
  `apps.js` edit.
- **Class-count rule.** New launcher styling must stay under
  `[data-variant="launcher"]`; don't add a second class to a tile/wrap.

## Related

- [apps.js](apps.md) — the app registry it renders (`appsFor`).
- [topbar.js](../topbar.md) — splices `appSwitcherHTML` into its actions nav.
- [framework index](index.md) · [component-registry](component-registry.md).
