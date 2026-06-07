---
title: frontend/scripts/rail-footer.js
source: ../../../../frontend/scripts/rail-footer.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-06-07
---

# rail-footer.js

## Purpose

Rail footer nav — the shared CROSS-APP UTILITY cluster living at the bottom of
every railed page's `.rp-rail-footer` (VS-Code / Slack style). The cluster carries,
in order: **Settings** link → **theme-toggle + sign-out** → **Profile** avatar.
Settings/Profile relocated off the topbar 2026-05-28; theme-toggle + sign-out
joined them 2026-06-07 (Em — declutter the per-app topbar). **Docs moved OUT**
2026-06-07 (Slice C) — it's a Support & Docs app page (topbar), reached via the
launcher, not a global footer link; the footer is utilities only now. The theme +
sign-out actions are the shared
[footer-utilities](framework/footer-utilities.md) (same render + wire helpers the
[framework/rail.js](framework/rail.md) footer uses), so the two footer paths can't
drift.

## Public surface

- `mountRailFooterNav(footEl, { active, session })` — paints the cluster. `active`
  names which entry is the current page (highlights it); `session` supplies the
  avatar initials for the Profile item.
- Idempotent — a re-mount replaces the prior cluster rather than stacking a second.

## How it works

- **Link → actions → avatar.** Settings renders as a `.rp-rail-footer-nav-item`
  link; `footerUtilitiesHTML()` injects the theme + sign-out buttons between it and
  the Profile avatar (the "you" anchor); `wireFooterUtilities` binds them.
- **Appended, not clobbering.** The cluster is appended to the foot so it coexists
  with page-specific create actions (New case / Upload / etc.).

## Drift-prone areas

- **Theme/sign-out are NOT defined here** — they come from
  [footer-utilities.js](framework/footer-utilities.md) so this path and the
  framework/rail.js path stay identical. Don't hand-roll them in this file.
- Active-entry styling depends on CSS sibling rules; adding a 4th link entry needs
  CSS support.

## Related

- [footer-utilities.js](framework/footer-utilities.md) — the shared theme/sign-out helpers.
- [framework/rail.js](framework/rail.md) — the component footer that composes the same helpers.
- [Frontend pillar landing](../../index.md)
