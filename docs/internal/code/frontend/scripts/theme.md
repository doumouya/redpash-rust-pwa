---
title: frontend/scripts/theme.js
source: ../../../../frontend/scripts/theme.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# theme.js

## Purpose

Theme — dark (default) <-> light. Thin shim over prefs.js. theme is a registered pref so write-through + boot seed + html data-attr reflection all happen via the unified prefs system.

## Public surface

- getTheme(), setTheme(theme), toggleTheme().
- Reflects <html data-theme="..."> for CSS to read.

## Drift-prone areas

- Reads prefs.PREFS.theme; theme registry in prefs.js needs the theme entry.

## Related

- [Frontend pillar landing](../../index.md)
