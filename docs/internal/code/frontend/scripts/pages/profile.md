---
title: frontend/scripts/pages/profile.js
source: ../../../../../frontend/scripts/pages/profile.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-05-30
---

# profile.js

## Purpose

Profile page — the user account surface. Loads /api/me, paints identity card + editable fields, fetches usage counters from CRUD lists. Edit-mode toggles between read-only and editable; Save -> PATCH /api/me.

## Public surface

- Default export: page mount.
- Uses page-row.js for the row stack.
- Full-bleed 2-step scroll-snap layout shared with Settings.

## Drift-prone areas

- DTO: shared::user::UserProfile. Endpoint contract: PATCH /api/me sparse-update.

## Related

- [Frontend pillar landing](../../../index.md)
