---
title: frontend/scripts/prefs.js
source: ../../../../frontend/scripts/prefs.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-31
---

# prefs.js

## Purpose

App-wide preferences — SWR cache over the server user_preferences table. Source of truth is the server (migration 023). localStorage holds a per-key cache so synchronous getPref does not block; cache seeded once at boot from /api/me + write-through to /api/me/prefs on every setPref.

## Public surface

- seedPrefs(serverPrefs) — boot seed.
- getPref(key) — sync cache read.
- setPref(key, value) — write-through (localStorage + PATCH).

## Drift-prone areas

- Wire: user_preferences table + /api/me/prefs PATCH protocol. See specs/user-preferences.md.
- Registered prefs (PREFS) are enum-validated with defaults + optional `<html>` attr reflection; unregistered keys pass through untouched. Per-surface Cases UI prefs live here too (casesDoneWindow, casesRailGroupBy, casesDetailPanel).

## Related

- [Frontend pillar landing](../../index.md)
