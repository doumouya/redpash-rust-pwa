---
title: frontend/scripts/theme.js
source: ../../../../frontend/scripts/theme.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-06-05
---

# theme.js

## Purpose

Theme switch — a thin shim over prefs.js (`general-theme` registered pref, so write-through + boot seed + `<html data-theme>` reflection happen via the unified prefs system). As of the 2026-06-05 design-language reset there are **four** themes: `dark`/`light` (catppuccin aliases — today's default, zero-visual), `new-dark`/`new-light` (the new RedPash identity), and `catppuccin-mocha`/`catppuccin-latte`. The palettes live in `tokens.css` (two-tier: a structure `:root` block + one palette block per `[data-theme]`).

## Public surface

- `currentTheme()` — read the active theme via the pref helper (enum-validated).
- `applyTheme(theme)` — set + persist (validated against the `THEMES` set; falls back to `dark`).
- `toggleTheme()` — flip dark <-> light (the topbar toggle).
- Reflects `<html data-theme="…">` for CSS to read.

## Drift-prone areas

- The `THEMES` set here is in **lockstep** with the `general-theme` `values` enum in `prefs.js` and the pre-paint validator in `index.html` — extend all three together.
- Palette values live in `tokens.css`; this module only flips the `data-theme` attr.

## Related

- [Frontend pillar landing](../../index.md)
