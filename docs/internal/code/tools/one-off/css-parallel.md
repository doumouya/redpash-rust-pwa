---
title: tools/css-parallel/audit.js
source: ../../../../../tools/css-parallel/audit.js
owner: Torv
section: Internal · Code · Tools · one-off
last modified date: 2026-05-30
---

# css-parallel

## Purpose

Detects page-prefixed classes (`.rp-foo`) that look like parallel
implementations of `rt-*` atoms. The smell: `rp-cases-modal` /
`rp-home-modal` / `rp-mon-modal` were parallel families of the same
atom, each maintained separately — the cleanest fix was to lift the
shared part into `rp-modal` (the modal-consolidation work, 2026-05-29).
This tool measures the `.rp-* ↔ .rt-*` (and cross-page `.rp-<a>-* ↔
.rp-<b>-*`) similarity score.

Sibling of [`css-cross-page-audit`](../audit-suite/css-cross-page-audit.md)
which catches the JS-side reference; this tool measures the CSS-side
similarity.

## Public surface

- Scans `frontend/styles/**/*.css`.
- Emits `parallels.html` + `parallels.json`.
- Not auto-discovered by `tools/audit.sh` — it lives outside the `*-audit/` glob (which is why it's in `one-off/`).

## Drift-prone areas

- **Similarity threshold** lives inline; tune when the candidate list gets noisy.
- **Atom set** (`rt-*` prefix) is hard-coded; if a new "foundation" layer ships, the tool needs updating.

## Related

- [Sibling: css-usage](css-usage.md)
- [Sibling: css-audit](../audit-suite/css-audit.md) — duplicate-decl-blocks finding overlaps with this audit
- [Audit-suite landing](../audit-suite/index.md)
