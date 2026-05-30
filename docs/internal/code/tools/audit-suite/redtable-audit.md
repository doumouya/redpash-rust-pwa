---
title: tools/redtable-audit/audit.js
source: ../../../../../tools/redtable-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-05-30
---

# redtable-audit

## Purpose

The redtable is the most-used UI primitive in RedPash. Every drift in
its class naming has cost real time — Em 2026-05-25: *"we can work
for 5 hours straight and because of css bullshit we git force reset
to an old version"*. This audit encodes the rules so they're
**enforced by tooling, not memory**.

## Public surface

- Canonical primitives (post-2026-05-25 alignment):
  - `.rt-table-wrap` — the immediate `<table>` parent (flex-fill, scrolls)
  - `.rt-table` — the `<table>` element itself
  - `.rt-table-state` — empty / loading / error placeholder
  - plus the `rt-tab-*` / `rt-group-*` / `rt-pred-*` families
- Scans `frontend/scripts/**/*.js`, `frontend/partials/*.html`, `frontend/styles/*.css`.
- Emits `report.html`. Auto-discovered as `redtable`.

## Drift-prone areas

- **Canonical-set list** is hard-coded; when a new redtable atom lands the audit needs the addition or it'll false-flag the new usage.
- **Page-prefixed parallels** (e.g. `rp-home-table-*`) get caught here AND by `css-cross-page-audit`; the two audits overlap by design.

## Related

- [Audit-suite landing](index.md)
- [Sibling: css-audit](css-audit.md)
- [Sibling: css-cross-page-audit](css-cross-page-audit.md)
- [Master runner: audit.sh](../shell/audit.md)
