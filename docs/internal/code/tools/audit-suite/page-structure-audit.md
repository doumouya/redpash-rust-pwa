---
title: tools/page-structure-audit/audit.js
source: ../../../../../tools/page-structure-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-06-04
---

# page-structure-audit

## Purpose

Diffs the layout skeleton of every page partial so structural drift
between pages surfaces as a finding instead of a *"why does this page
look different"* bug. Em 2026-05-29: *"diff the order of divs between
pages to see some incoherence"* + *"rp-surface should be the default
next div after rp-main on all pages"*.

Parses `frontend/partials/*.html`, builds a shallow element tree of
the layout containers, and checks each shell page's chain against the
canonical pattern.

## Public surface

- **Chain check (the CI gate):** validates `section.rp-shell > div.rp-shell-body > main.rp-main >
  .rp-surface` (first child) per page; exit 1 on any deviation. Auto-discovered as `page-structure`.
- **Container-comparison report (the shell delta):** for `rt-nav` / `rp-main` / `rp-surface` it
  enumerates the element tree inside each container and compares it page-by-page — a presence matrix
  (which pages have each direct child) + the per-page tree. Makes structural delta explicit (e.g.
  `rt-nav-views` only on workspace+monitoring; cases' `rp-main` holds *two* `rp-surface` children;
  workspace uses `.rt-rail-filter` while cases reinvents `.rp-cases-rail-filter`). The page-side analog
  of `fe-inventory` — the foundation for the dedup pass + the per-page docs.
- Emits `shell-structure.json` (the delta artifact — regenerable, gitignored). Output is stdout + that
  JSON; no `report.html`.
- Scans `frontend/partials/*.html`; `login.html` exempt (standalone layout).

## Drift-prone areas

- **Canonical chain** is hard-coded in the audit; if the shell pattern evolves (e.g. new wrapper layer), the audit needs updating in lockstep with the partials.
- Per-page exceptions (cases has a different `.rp-main` shape with `overflow: hidden`) may need inline opt-out.

## Related

- [Audit-suite landing](index.md)
- [Architecture: ui-shell-pattern](../../../architecture/ui-shell-pattern.md)
- [Sibling: html-audit](html-audit.md) — extraction candidates
- [Master runner: audit.sh](../shell/audit.md)
