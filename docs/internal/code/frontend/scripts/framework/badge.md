---
title: frontend/scripts/framework/badge.js
source: ../../../../../../frontend/scripts/framework/badge.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/badge.js — soft-tint label pill

## Purpose

The passive soft-tint label pill (`rp-badge`), replacing the ~4 page-local copies
(profile.css plan / "Soon" / membership role / connection-state). Distinct from
`rp-status` (leading dot) and `rp-chip` (interactive filter) — `rp-badge` is a
passive label (form-control set, CAS_37B2E1BF). CSS: `styles/framework/badge.css`
(greenfield; a later pass may fold it into atoms.css, Torv-A's lane).

## Public surface

- `badgeHTML({ label, tone?, icon? })` → markup string for inline composition (inside
  rp-head / a field / a table cell).
- `mountBadge(host, opts)` → fills `host` (host becomes the badge). Self-registers as `"badge"`.
- Tones: `accent · ok · warn · soon · neutral`.

## How it works

A tiny class+content builder; every label/icon is `esc()`'d. `mountBadge` sets the
host's class + inner content (no `outerHTML`, no detachment).

## Related

- `styles/framework/badge.css` · [field](field.md) · used by the Profile record (plan/role/connection) · [component-registry](component-registry.md).
