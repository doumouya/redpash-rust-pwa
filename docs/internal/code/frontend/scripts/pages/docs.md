---
title: frontend/scripts/pages/docs.js
source: ../../../../../frontend/scripts/pages/docs.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-05-30
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

## Related

- [Frontend pillar landing](../../../index.md)
