---
title: tools/html-audit/audit.js
source: ../../../../../tools/html-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-05-30
---

# html-audit

## Purpose

Component-extraction audit. Parses every partial under
`frontend/partials/`, hashes every element subtree three ways, and
surfaces reusable-component candidates ranked by how many lines
extracting them would save. The audit that surfaced the modal /
chip-row / list-page rollup opportunities.

## Public surface

- Match tiers (strongest first):
  - **exact** — byte-identical subtree (whitespace-normalised).
  - **class** — identical tag tree + identical class lists; only ids / text / data-* differ.
  - **shape** — identical tag tree; everything else can vary.
- Emits `report.html` + `audit.json` (ingest-compatible).
- Auto-discovered as `html`.

## Drift-prone areas

- **Subtree hashing** normalises whitespace + ids + text; new attribute kinds (`data-*`, `aria-*`) may need explicit handling.
- **Ranking weights** (lines-saved × match-tier) live inline; tune when the candidate list gets noisy.

## Related

- [Audit-suite landing](index.md)
- [Sibling: page-structure-audit](page-structure-audit.md) — structural-skeleton diff
- [Master runner: audit.sh](../shell/audit.md)
