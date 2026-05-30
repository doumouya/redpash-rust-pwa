---
title: frontend/scripts/format.js
source: ../../../../frontend/scripts/format.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-05-30
---

# format.js

## Purpose

Format primitives — ISO timestamp / age / clock / day helpers used across the frontend. Extracted per the cases-UI review (2026-05-25). Inline duplicates still live in some pages (fmtTime in home/monitoring); future consolidation slots into this module.

## Public surface

- fmtAge(iso), fmtTime(iso), fmtClock(iso), dayKey(iso), dayLabel(iso).
- All deterministic, no locale handling yet.

## Drift-prone areas

- Locale + timezone handling is hardcoded (UTC ISO in, local-ish display); proper i18n would replace this module.

## Related

- [Frontend pillar landing](../../index.md)
