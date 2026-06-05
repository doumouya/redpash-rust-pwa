---
title: frontend/scripts/pages/docs.js
source: ../../../../../frontend/scripts/pages/docs.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-06-05
---

# docs.js

## Purpose

Docs page — rail-driven viewer. Rail = section groups, each containing doc tabs. Body = rendered markdown at full width. Hash routes the active doc (#/docs?slug=foo); bare #/docs loads the first doc.

## Public surface

- Default export: page mount.
- Fetches /api/docs/index for the doc tree, /api/docs/:slug for content.
- Slug routing via ?slug= query.

## Drift-prone areas

- Backend endpoint shapes from crates/api/src/routes/docs.rs.
- The doc heading renders the `rp-title` atom inside `.rp-doc-head` (sized by the
  `.rp-doc-head .rp-title` context, not a `rp-doc-title` class — CAS_37B2E1BF).
- **Rail uses the framework `rp-rail*` atoms** (design-language rollout, 2026-06-05). The
  section groups + doc tabs are **rendered in JS** (`renderGroup`/`renderTab` emit
  `rp-rail-group*` / `rp-rail-tab*` string literals) and queried back (click delegation
  `closest('.rp-rail-group-head'|'.rp-rail-tab')`, `loadDoc`'s `.rp-rail-tab.active` /
  `[data-slug]`, the rail-state strings, the footer-nav mount `.rp-rail-footer`). Markup +
  these JS sites move in lockstep — a rename in one without the other silently leaves the rail
  unstyled. Group expand-state is plain `.expanded`, active tab plain `.active` (the
  `rp-rail-group`/`rp-rail-tab` atom contracts, rail.css).

## Related

- [Frontend pillar landing](../../../index.md)
