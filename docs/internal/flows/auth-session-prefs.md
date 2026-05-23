---
title: Login → session → prefs applied
section: Internal
order: 44
last modified date: 2026-05-24
status: stub
---

# Flow: Login → session → prefs applied

> **TODO.** Fill once the boot-splash + real-auth pass lands (currently dev-login only).

To cover:

- `index.html` inline boot script: reads `rp-pref-{theme,density,fontSize}` (with legacy fallback), applies to `<html>` data-attrs BEFORE first paint (FOUC-safe)
- Module load: `prefs.js`'s one-shot legacy-key migration runs (`rp-density` → `rp-pref-density` JSON, etc.)
- `main.js#loadSession`: `await api.get("/me")` → returns `{ user fields..., prefs: { ... } }`
- `seedPrefs(session.prefs)`: overwrites localStorage cache with server-of-truth, re-applies data-attrs (catches up the inline script's first pass)
- Page renders: every consumer's `getPref(name)` is synchronous + correct
- Settings page: `setPref` writes through → cache + data-attr + fire-and-forget PATCH /api/me/prefs
- Logout (`/auth/logout`): clears cookie; hash → `#/login`; the next mount's `/api/me` 401s; `session = null`

To document:

- The 401 from `/api/me` for unauthed users (expected, logged by `capture_mw`)
- Cache vs server divergence: setPref's PATCH is fire-and-forget; next boot's seedPrefs is the correction pass
