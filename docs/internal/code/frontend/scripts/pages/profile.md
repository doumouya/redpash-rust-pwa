---
title: frontend/scripts/pages/profile.js
source: ../../../../../frontend/scripts/pages/profile.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-06-05
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
- **Rail uses the framework `rp-rail*` atoms** (design-language rollout, 2026-06-05): the
  rail is `rp-rail` / `-head` / `-title` / `-body` / `-footer` (note `-footer`, not the legacy
  `rt-nav-foot`), collapse button is `rp-btn-icon`. The rail tabs are **JS-generated** here
  (`mountProfileRail` emits `rp-rail-tab` / `-tab-icon` / `-tab-name` string literals) and queried
  by `.rp-rail-tab`; the footer-nav mount targets `.rp-rail-footer`. Markup + these JS sites must
  stay in lockstep — a class rename in one without the other silently breaks the rail. Active tab
  is plain `.active` (the `rp-rail-tab` atom's contract, rail.css), not `aria-*`.

## Related

- [Frontend pillar landing](../../../index.md)
