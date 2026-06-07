---
title: frontend/scripts/topbar.js
source: ../../../../frontend/scripts/topbar.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-06-07
---

# topbar.js

## Purpose

Topbar — the shared chrome for authed pages, now **APP-SCOPED** (multi-app model,
Slice A). A page drops `<header id="rp-topbar">` and calls
`mountTopbar(el, { active, session })`; the topbar DERIVES which app owns `active`
([apps.js](framework/apps.md) `appForPage`) and renders only **that app's nav** +
the launcher ([app-switcher.js](framework/app-switcher.md)). Layout:
brand · omnibox · [launcher | app pages]. Theme + sign-out **moved to the rail
footer** (2026-06-07, Em — [footer-utilities.js](framework/footer-utilities.md));
the topbar no longer carries them.

## Public surface

- `mountTopbar(el, { active, session })` — paints brand (time-of-day greeting) +
  omnibox + the active app's nav (launcher + per-page icons). Pages pass only
  `active` + `session` — never an `app`; the topbar self-determines the app.
- Omnisearch dropdown reads `/api/search`.

## Drift-prone areas

- **No per-page mountTopbar changes for nav.** The topbar self-determines the app
  from `active` via `appForPage`, so adding/moving a page is a **one-line edit in
  [apps.js](framework/apps.md)** and never touches a page's `mountTopbar` call.
  The old flat `NAV` array is gone — page-nav now lives per-app in `apps.js`.
- **App = RBAC boundary.** Admin apps (`admin:true` → `is_platform_admin`) are
  filtered by `appsFor` inside the launcher, so non-admins never see the Admin
  tile/pages (Monitoring today, CAS_274EDF3B). The `main.js` route guard + the
  backend `require_platform_admin_mw` are the companions (URL deep-link + real
  auth).
- **Utility pages belong to no app.** profile / settings (rail-footer
  destinations) fall back to the **Home** app via `appForPage`, so their topbar
  is just the launcher (you jump back into an app from it).

## Related

- [apps.js](framework/apps.md) — the app registry the topbar reads (`appForPage`).
- [app-switcher.js](framework/app-switcher.md) — the launcher it splices into its nav.
- [footer-utilities.js](framework/footer-utilities.md) — theme/sign-out that moved to the rail footer.
- [Frontend pillar landing](../../index.md)
