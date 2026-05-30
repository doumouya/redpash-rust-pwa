---
title: tools/css-cross-page-audit/audit.js
source: ../../../../../tools/css-cross-page-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-05-30
---

# css-cross-page-audit

## Purpose

Detects `.rp-<pageA>-*` class references in JS files OTHER than
`pages/<pageA>.js`. The cleanest fix to such a leak is to **promote
the class into the `rt-*` atom layer** — the leak itself is the
evidence that the class wasn't actually page-specific. This is the
audit that caught the cases.js modal classes being reused by home.js
(2026-05-29), prompting the `rp-modal-*` consolidation.

Catches what `css-parallel` doesn't: that tool measures `.rp-* ↔
.rt-*` similarity; this one measures **`.rp-<a>-* used outside
`pages/<a>.js`** — a foreign reference to a page-prefixed class.

## Public surface

- Scans `frontend/scripts/**/*.js` for class-name references.
- Emits `report.html` + `audit.json` (ingest-compatible).
- Auto-discovered as `cross-page`. **This audit IS gating** — fails the build when foreign refs > 0.
- Inline opt-out: `// css-cross-page-allow: <class>` on the reference line.

## Drift-prone areas

- The "owner" determination assumes `pages/<page>.js` is the canonical owner of `rp-<page>-*` classes. New page namings (sub-page dirs) need owner detection rules.
- HTML partials are scanned via a separate audit; this one is JS-only.

## Related

- [Audit-suite landing](index.md)
- [Sibling: css-audit](css-audit.md)
- [Sibling: css-parallel](../one-off/css-parallel.md)
- [Master runner: audit.sh](../shell/audit.md)
