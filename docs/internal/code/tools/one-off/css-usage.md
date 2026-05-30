---
title: tools/css-usage/audit.js
source: ../../../../../tools/css-usage/audit.js
owner: Torv
section: Internal · Code · Tools · one-off
last modified date: 2026-05-30
---

# css-usage

## Purpose

Maps every CSS class and ID across the project to where it's defined
(`frontend/styles/`) and where it's consumed (in HTML partials and
JS sources). The "find every reference to `.rt-tab`" command, but
exhaustive across the whole tree — the dataset many other CSS-family
audits build on.

## Public surface

- Scans `frontend/styles/*.css`, `frontend/partials/*.html`, `frontend/scripts/**/*.js`.
- Emits `usage.html` (datatable view) + `usage.json`.
- Not auto-discovered by `tools/audit.sh` — lives outside the `*-audit/` glob.

## Drift-prone areas

- **Class-name extraction** uses regex over CSS/HTML/JS; new CSS-in-JS shapes (template literals computing class names) would slip past.
- The output JSON is consumed by other audits in the family; format changes ripple.

## Related

- [Sibling: css-parallel](css-parallel.md) — built on this audit's output
- [Sibling: css-audit](../audit-suite/css-audit.md) — sibling in the css-family
- [Audit-suite landing](../audit-suite/index.md)
