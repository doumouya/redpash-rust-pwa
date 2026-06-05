---
title: tools/css-twin-verify/verify.js
source: ../../../../../tools/css-twin-verify/verify.js
owner: Torv
section: Internal · Code · Tools · css-twin-verify
last modified date: 2026-06-05
---

# css-twin-verify/verify.js

## Purpose

The **twin classifier** for the design-language `rt-*`→`rp-*` rollout. Given a
page sheet (e.g. `frontend/styles/panel.css`) and the framework dir
(`frontend/styles/framework/`), it decides, per rule, whether it is:

- **DELETE** — a byte-equivalent framework duplicate (the framework atom owns it;
  the page copy is dead weight once the page's consumers emit the `rp-*` name);
- **DIVERGE** — the framework has the same (prefix-normalised) selector but with
  DIFFERENT declarations — a manual decision (adopt the framework canonical, or
  keep the page override);
- **RENAME** — unique to the page (no framework twin) — survives, renamed in place.

This is the data that drives a slice's panel-sheet untangle + every page's
last-consumer cleanup in Phase C. It is read-only (prints a report); the actual
edits are applied by [migrate.js](migrate.md).

## How it works

- Splits each sheet into `(selector, declaration-block)` rules with a flat regex
  (`@`-headers skipped; comments stripped first so an inline-comment'd decl still
  compares clean; declaration whitespace collapsed so formatting differences
  don't cause false "diverge").
- Normalises selectors **prefix-agnostically** (`\b(rt|rp)-` → `X-`) so an
  `rt-pred` page rule matches its `rp-pred` framework twin. NB: this catches only
  STRAIGHT prefix swaps — non-straight renames (`btn`→`btn-icon`, `field-lbl`→
  `label`, `--filter`→`-filter` de-BEM) read as RENAME until the sheet is first
  put through `migrate.js rename`. The canonical workflow is therefore **rename
  the page sheet first, then verify** — on the all-`rp-` file the comparison is
  exact and the DELETE set is definitive.

## Usage

```
node tools/css-twin-verify/verify.js <page.css> <framework-dir>
```

## Drift-prone areas

- Combined-selector framework rules (`.rp-seg button.is-active, .rp-seg button[aria-pressed="true"]`)
  do NOT match an individual page rule (`.rp-seg button.is-active`) — the verifier
  reports it as RENAME even though the framework functionally covers it. Cross-check
  combined selectors by hand before keeping such a "survivor".
- `@keyframes` step selectors (`to` / `from` / `NN%`) parse as bare rules and can
  match a framework keyframe step — a known false-DELETE; `migrate.js prune` skips
  them, but the verifier still lists them. Treat `to`/`from` in the DELETE column
  as noise.

## Related

- [migrate.js](migrate.md) — the renamer + pruner that acts on this classification.
- [Tools pillar landing](../../index.md)
