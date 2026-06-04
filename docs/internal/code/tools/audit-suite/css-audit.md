---
title: tools/css-audit/audit.js
source: ../../../../../tools/css-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-06-04
---

# css-audit

## Purpose

The most-mature audit in the suite — sets the shape every other
`tools/*-audit/audit.js` follows. Parses every `.css` file under
`frontend/styles/` and produces an interactive HTML datatable to spot
competing rules that style identical classes differently. Tracks two
related smells: *selector conflicts* (the same selector declared in
2+ places with per-property value diffs) and the *class index* (every
class name with every file/selector that targets it).

Also reports `duplicate decl blocks` — identical declaration bodies
under 2+ distinct selectors, ranked by consolidation weight (decls ×
distinct selectors). This is the metric the modal-atom consolidation
and the columns-toolbar rework worked against.

## Public surface

- Scans `frontend/styles/**/*.css`.
- Emits `report.html` (datatables view) + `audit.json` (ingest-compatible).
- Auto-discovered as `css`. Ingest-wired.
- Inline opt-out: `// css-audit-allow: <selector>` on the rule line.
- **Reachability** view: every `.css` under `styles/` must be reached from a
  `<link>` root or the `@import` graph — flags orphan sheets + dangling imports.
  `@import`/`<link>` targets resolve by full STYLES_DIR-relative path
  (subdir-aware, e.g. `framework/atoms.css`), not basename — so the framework
  `@import` block in `main.css` resolves correctly (was basename-stripped before).

## Drift-prone areas

- **Selector parsing** uses regex over a hand-written CSS pseudo-parser; new at-rules (`@container`, `@layer`) may not be tracked correctly.
- **Duplicate-decl-block ranking** is byte-identical match; semantic equivalence (same gradient via different syntaxes) isn't caught.
- The `duplicate-cluster` finding has been the workhorse signal for cross-page consolidation work (rp-modal, columns toolbar).

## Related

- [Audit-suite landing](index.md)
- [Sibling: css-cross-page-audit](css-cross-page-audit.md) — page-class leaks
- [Sibling: css-tab-compare-audit](css-tab-compare-audit.md) — per-tab CSS diff
- [Master runner: audit.sh](../shell/audit.md)
