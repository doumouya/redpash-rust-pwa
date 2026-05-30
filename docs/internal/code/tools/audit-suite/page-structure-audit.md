---
title: tools/page-structure-audit/audit.js
source: ../../../../../tools/page-structure-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-05-30
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

- Canonical chain check: `.rp-shell-body` → `.rp-main` → `.rp-surface` → page body.
- Scans `frontend/partials/*.html`.
- Emits `report.html`. Auto-discovered as `page-structure`.

## Drift-prone areas

- **Canonical chain** is hard-coded in the audit; if the shell pattern evolves (e.g. new wrapper layer), the audit needs updating in lockstep with the partials.
- Per-page exceptions (cases has a different `.rp-main` shape with `overflow: hidden`) may need inline opt-out.

## Related

- [Audit-suite landing](index.md)
- [Architecture: ui-shell-pattern](../../../architecture/ui-shell-pattern.md)
- [Sibling: html-audit](html-audit.md) — extraction candidates
- [Master runner: audit.sh](../shell/audit.md)
