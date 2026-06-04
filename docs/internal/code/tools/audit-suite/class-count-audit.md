---
title: tools/class-count-audit/audit.js
source: ../../../../../tools/class-count-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-06-04
---

# class-count-audit

## Purpose

The **coherence burndown scoreboard** for the framework epic (CAS_37B2E1BF).
Em's rule: an atom carries a **maximum of one framework class** (`rp-/rt-/ds-/ws-`)
plus **one id** — class-stacking is the dedup target. A variant that follows a
container → ancestor CSS; a container-independent variant → a `data-variant` attr;
state → an `aria-*` attribute. So an atom is one framework class + (data-attrs,
aria-attrs, a `bi bi-…` vendor icon, one id) and nothing else.

Auto-discovered by `tools/audit.sh` as tool `class-count`. Advisory (exit 0) — like
the rest of the suite, `ci-audit` gates *new* violations via `audit.run_diff`; the
absolute count is the metric the campaign drives down.

## Public surface

`node tools/class-count-audit/audit.js` → console scoreboard + `audit.json`
(`{tool, generatedAt, summary, findings}`). Always exits 0.

## How it works

Regex-scans every **static `class="…"` literal** across `frontend/scripts/**`,
`frontend/partials/*.html`, and `index.html` (the demo `framework-sandbox.html` is
excluded — it is not shipped). For each element's class list it flags:

- **`multi_framework_class`** (HIGH) — ≥2 framework tokens (`^(rp|rt|ds|ws)-`, the
  `bi` vendor icon excluded) on one element. This is the burndown metric: an
  identity-stack (`rp-chip rp-settings-tag`) or a modifier-stack
  (`rp-btn-icon rp-btn-icon--accent`) both count. Collapse to one atom; move the
  extra to ancestor context or a `data-variant`.
- **`legacy_state_class`** (advisory) — `is-`/`has-` prefixes or a bare state word
  (`active`/`open`/`selected`/`busy`/…) → migrate to `aria-*`
  (`is-active` → `aria-pressed`/`aria-selected`/`aria-current`; `open` → `aria-expanded`).

`summary` = `{ filesScanned, classAttrs, multiFrameworkClass, legacyStateClass }`.
Baseline at creation (2026-06-04): **252 multi-framework-class · 132 legacy-state**
over 2021 class literals in 95 files.

## Drift-prone areas

Static literals only — the bulk of markup stacking. Dynamic `className =`/`classList`
toggles (mostly state) are the `aria-*` migration and are **not** linted here; a
dynamic concat (`class="rp-x' + …`) whose attr-close `"` sits later on the line is
still captured, so modifier-stacks built by concatenation are caught. No Acorn
needed (regex over the class attribute), so it sits outside the
[no-frameworks](../../../../architecture/js-rust-boundary.md) carve-out entirely.

## Related

- [ui-doc-audit](ui-doc-audit.md) — divergences / parallel-clusters / namespace legacy (the complementary dedup view).
- [css-cross-page-audit](css-cross-page-audit.md) — per-page CSS leaks.
- [fe-inventory](../lib/fe-inventory.md) — the class enumeration the other audits build on.
- Plan: `~/.claude/plans/hi-need-a-plan-golden-treasure.md` (the ≤1-class-per-atom campaign).
