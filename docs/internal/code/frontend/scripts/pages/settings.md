---
title: frontend/scripts/pages/settings.js
source: ../../../../../frontend/scripts/pages/settings.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-05-30
---

# settings.js

## Purpose

Settings page — app preferences. Declarative: SETTINGS_ROWS defines what each section contains; render() materialises via page-row.js helpers. The html-audit flagged rp-page__row as the heaviest duplication signal; centralising kept the contract in one place.

## Public surface

- Default export: page mount.
- Reads / writes via prefs.js (SWR cache + write-through).
- Charts management section per-tab (uses charts/home-bank.js schema).

## Drift-prone areas

- Pref-key registry lives in prefs.js; new prefs need entries on both sides + a row spec here.

## Related

- [Frontend pillar landing](../../../index.md)
