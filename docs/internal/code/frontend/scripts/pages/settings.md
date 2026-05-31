---
title: frontend/scripts/pages/settings.js
source: ../../../../../frontend/scripts/pages/settings.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-05-31
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
- **Rail grouped by PAGE, not by ABILITY (2026-05-31 CAS_3FC70F56):** `SET_GROUPS` are GENERAL / HOME / WORKSPACE / CASES / MONITORING. `SET_TABS` assigns each section to its owning page (e.g. `set-tables` lives under WORKSPACE because rows-per-page-Workspace is the dominant row there; the per-surface rows-per-page split stays). Section IDs (set-*) are preserved across the regroup so deep-links + pref keys are unchanged — only the rail layout changes. New page-scoped prefs land in their group's matching SETTINGS_ROWS entry; if a new page needs settings, add a `set-<page>` section to settings.html + a SETTINGS_ROWS entry + a SET_TABS entry under the right group.

## Related

- [Frontend pillar landing](../../../index.md)
