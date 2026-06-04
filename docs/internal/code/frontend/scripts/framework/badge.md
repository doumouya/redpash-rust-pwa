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
- Tones: `accent · ok · warn · soon · neutral` — emitted as a `data-variant` attribute
  (e.g. `data-variant="ok"`), not a modifier class. `neutral` emits no attribute (base look).

## How it works

A tiny attribute+content builder; every label/icon is `esc()`'d. The base atom is always
`class="rp-badge"`; the tone is carried on `data-variant` and the CSS keys off the attribute
(`.rp-badge[data-variant="ok"]`), per the one-framework-class convention. `mountBadge` sets the
host's class + `data-variant` + inner content (no `outerHTML`, no detachment).

## Drift-prone areas

- **Tone ↔ selector pairing.** Tones are `data-variant` values (the `TONES` map), not
  `--modifier` classes; each must have a matching `.rp-badge[data-variant="…"]` rule in
  `badge.css`. Add a tone → add BOTH the map entry and the CSS selector, or the new tone
  silently renders as the base pill.
- **`neutral` emits no attribute** (the base look) — don't "fix" it to `data-variant=""`,
  which would target an empty-value selector nobody styles.
- A later pass may fold `badge.css` into `atoms.css` (Torv-A's lane); keep the
  `[data-variant]` selector form so the move is a copy, not a rewrite.

## Related

- `styles/framework/badge.css` · [field](field.md) · used by the Profile record (plan/role/connection) · [component-registry](component-registry.md).
