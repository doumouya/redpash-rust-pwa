---
title: tools/retired-class-audit/audit.js
source: ../../../../../tools/retired-class-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-06-07
---

# retired-class-audit/audit.js

## Purpose

The **retired-class-prefix gate** — the standing check that would have caught the
chart-designer regression (runbook 0017) on the commit that introduced it. A
design-language dedup renames a class **family** in CSS (`ds-*` → `rp-dash-*`,
`rt-*` → `rp-*`) and deletes the old sheet; if a JS/HTML **emitter** still ships
the old name, the canonical rule never matches the live DOM — controls unstyle and
the `.ds-chart` ECharts mount loses its `height:100%` rule, so the chart preview
renders empty. The CSS-side audits miss it (the CSS is already correct — the drift
is in the emitter), so this gate watches the **emitters**.

## Public surface

A single auto-discovered CLI audit — no exported API. Invocation + contract:
`node tools/retired-class-audit/audit.js` → prints the watched retired→canonical
families + either `OK` (exit 0) or the `file:line  .old → .canonical` drift list
(exit 1). Configuration is the in-file `RETIRED` map. Emits no `audit.json` (no
ingest); the exit code is the whole interface to `tools/audit.sh`.

## How it works

- Scans **`frontend/scripts/**/*.js`** + **`frontend/partials/*.html`** +
  `frontend/index.html`, **comment-stripped** (block comments blanked in place so
  line numbers stay exact; `//` line comments spared of `http://`). Comment-stripping
  is what keeps the gate false-positive-free — a class-like token in a comment (e.g.
  redtable.js's `// ".rt-table"`) is not a real emit.
- Extracts class/id references the way the DOM is actually built: `class="…"` /
  `id="…"` attrs (incl. JS inline-HTML template strings), `querySelector(All)` /
  `closest` / `matches` selector strings, `getElementById`,
  `classList.add/remove/toggle/contains/replace`, **`el.className = "…"` / `el.id = "…"`
  property assignments**, and **`setAttribute("class"|"id", "…")`** — designer.js builds its
  tiles via `el.className =`, so that pattern is covered (a string-literal value only; a
  dynamically-concatenated `el.className = base + x` can't be checked statically).
- **Limitation (by design):** this is a *prefix-family* gate — it cannot catch a renamed
  **bare** class (e.g. the dedup's `span-N → rp-dash-span-N`, `selected → is-selected`,
  `open → is-open`, `active → is-active`) because there's no retired prefix to key on. Those
  bare/state renames are caught by review + the (non-gating) css-usage `undefined`-class report.
- Any reference whose prefix is in **`RETIRED`** fails (exit 1), printing
  `file:line  .old  →  .canonical` for each.

## The retired set (deliberately staged)

`RETIRED = { 'ds-': 'rp-dash-' }`. **`ds-` is FULLY retired**, so any live reference
is drift. **`rt-` is intentionally NOT gated yet** — the `rt-toolbar` / `rt-dd` /
`rt-designer` / `rt-spinning` tail still matches live `.rt-*` CSS (the dashboards lane
hasn't finished that port), so gating `rt-` now would fail consistent, working markup.
Add `'rt-': 'rp-'` to `RETIRED` once that lane lands — the comment-strip already makes
that entry safe against the `.rt-table` comment.

## Usage

```
node tools/retired-class-audit/audit.js     # gate: exit 1 on any retired-family emit
```
Auto-discovered + run by `sh tools/audit.sh` (the `tools/*-audit/` glob); no ingest
(emits no `audit.json`, just the console summary + exit code).

## Drift-prone areas

- **Adding to `RETIRED` is a reviewed act**, gated on the family being *fully* migrated
  in CSS first — gating a half-migrated family fails working markup.
- **Sibling of [uniformity-audit](../uniformity-audit/audit.md):** that one gates new
  foreign **families** in partials/pages; this one gates **retired** families across
  JS+HTML. Both are precise-by-design (zero false positives = trustworthy gate).

## Related

- [audit.sh](../shell/audit.md) — the suite runner that discovers this.
- [uniformity-audit](../uniformity-audit/audit.md) — the family-gate sibling.
- Runbook `docs/internal/runbooks/0017-designer-ds-class-drift.md`.
