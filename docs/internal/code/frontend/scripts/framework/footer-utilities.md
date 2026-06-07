---
title: frontend/scripts/framework/footer-utilities.js
source: ../../../../../../frontend/scripts/framework/footer-utilities.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-07
---

# framework/footer-utilities.js — Footer utilities (theme + sign-out)

## Purpose

The **theme-toggle + sign-out** actions that moved OFF the topbar INTO the rail
footer (2026-06-07, Em — declutter the per-app topbar; these are app-independent
utilities, not nav). One `render` + one `wire` helper so **both** rail-footer
paths — [rail-footer.js](../rail-footer.md) (the live page-mounted footer) and
[framework/rail.js](rail.md) (the component twin) — share **identical markup +
behavior** without duplicating the theme/logout logic.

## Public surface

- `footerUtilitiesHTML()` → the theme + sign-out action buttons as a string. They
  compose the same `.rp-rail-footer-nav-item` atom the footer links use; the
  buttons carry `data-act="theme"` / `data-act="signout"`.
- `wireFooterUtilities(scopeEl)` → wires those two buttons within `scopeEl`. Safe
  to call per mount (fresh elements each render); no-op when `scopeEl` is null.

## How it works

- **Theme.** The theme icon shows the **CURRENT** theme (Light ↔ `bi-sun`,
  Dark ↔ `bi-moon-stars`) — aligned with the Settings → Appearance row. Clicking
  calls `toggleTheme()` ([theme.js](../theme.md)) then repaints the icon.
- **Sign-out.** `POST /api/auth/logout` (idempotent — the client session is
  cleared regardless of the response), then `location.hash = "#/login"` +
  `location.reload()`.
- **Shared, not duplicated.** Both footer renderers call the same two helpers, so
  the theme/logout behavior can only drift in one place.

## Drift-prone areas

- **Both footer paths must compose these helpers** — a new footer path that
  hand-rolls a theme/sign-out button reintroduces the duplication this module
  exists to remove.
- **Icon reflects state, not action** (current theme, not "switch to X"); a flip
  to action-labelling would invert the icon mapping.

## Related

- [rail-footer.js](../rail-footer.md) — live page footer; composes both helpers.
- [framework/rail.js](rail.md) — component footer; composes both helpers.
- [theme.js](../theme.md) — `toggleTheme` / `currentTheme` it calls.
- [framework index](index.md) · [component-registry](component-registry.md).
