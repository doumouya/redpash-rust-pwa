---
title: tools/css-tab-compare-audit/audit.js
source: ../../../../../tools/css-tab-compare-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-05-30
---

# css-tab-compare-audit

## Purpose

Cross-compares the CSS classes / IDs used by two list-page tabs (each
tab is a `LIST_VIEWS[<key>]` entry in a page JS file). Surfaces
*same-role-different-name* leaks where two classes have a matching
normalised suffix but different page-family prefixes (e.g.
`.rt-mon-row-clickable` vs `.rp-home-row--clickable`). The
[[naming-consistency]] + [[unify-behavior-not-names]] principles are
encoded here: pages doing the same thing should use the same atom.

## Public surface

- Scans `frontend/scripts/pages/**/*.js` for `LIST_VIEWS` entries and walks each tab's class set.
- Emits `report.html` + `audit.json` (ingest-compatible).
- Auto-discovered as `tab-compare`.

## Drift-prone areas

- **Suffix normalisation** drops `--modifier` and `--variant` BEM-style segments; aggressive normalisation could create false matches between semantically-distinct classes.
- Only compares tabs *within the same page family* (home tabs vs home tabs); cross-page comparison is in `css-cross-page-audit`.

## Related

- [Audit-suite landing](index.md)
- [Sibling: css-audit](css-audit.md)
- [Sibling: css-cross-page-audit](css-cross-page-audit.md)
- [Master runner: audit.sh](../shell/audit.md)
