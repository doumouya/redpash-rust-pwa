---
title: User preferences
section: Internal
order: 26
last modified date: 2026-05-24
owners: Gus (table + endpoints) + Torv (SWR cache + boot apply)
status: stub
---

# User preferences

> **TODO (Gus).** Server-side: `user_preferences` table (migration 023), `PATCH /api/me/prefs`, find-or-update semantics, `/api/me` `prefs:` projection.
> **TODO (Torv).** Client-side: `prefs.js` SWR cache, `rp-pref-<name>` namespace, legacy-key migration, `seedPrefs(serverPrefs)` boot wiring, `index.html` inline FOUC-safe apply.

To cover:

- Two-layer model: server table (source of truth) + localStorage cache (synchronous reads for paint)
- Wire: boot reads via `/api/me` → `seedPrefs` populates cache + applies `<html>` data-attrs → CSS reacts before paint
- Write-through: `setPref(name, value)` → cache + data-attr + fire-and-forget PATCH
- Pref classes: **registered** (PREFS table, enum-validated, default + CSS attr) vs **unregistered** (passthrough)
- Adding a new pref — when to register vs leave unregistered
- See also: [specs/user-preferences.md](../specs/user-preferences.md) for the wire spec
