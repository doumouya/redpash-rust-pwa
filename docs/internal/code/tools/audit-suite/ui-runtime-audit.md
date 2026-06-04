---
title: tools/ui-runtime-audit/audit.js
source: ../../../../../tools/ui-runtime-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-06-04
---

# ui-runtime-audit

## Purpose

The runtime × static divergence check. The static enumerator
[`tools/lib/fe-inventory.js`](../lib/fe-inventory.md) lists every component that
*exists in the source*; this tool checks that list against what the app
*actually renders* — the `?audit=2` captures
([`snapshot.js` `captureInventory()`](../../frontend/scripts/audit/snapshot.md),
driven by Playwright). It's the comparator half of the lane split agreed on
broadcast (2026-06-04): runtime capture + verification here; the static
enumerator / gate / catalog in the `fe-inventory` / `ui-doc-audit` / `doc-gen`
lane. It's the check that found the `__`-BEM completeness hole (fixed `003141e`),
and the structural half of the visual-regression guard during the
shell-normalization + CSS-dedup campaign.

## Public surface

- Auto-discovered by `audit.sh` as `ui-runtime`. No-ops (exit 0) when there are
  no captures — it needs a live app + a Playwright capture pass, so it can't run
  in plain headless CI.
- Reads `?audit=2` inventory captures from `captures/` (single-capture objects
  or combined `{label:{classes}}` maps).
- Baseline = **live `require('../lib/fe-inventory').inventory()`** (not the
  gitignored `component.contract.json`) — so the comparator can't drift from the
  true current static enumeration.
- Findings: `rendered_not_enumerated` (HARD — a class rendered but not
  enumerated = an fe-inventory completeness hole, file it) · `enumerated_not_rendered`
  (advisory — gated/dead candidate). Emits `report.html` + `audit.json`.

## Drift-prone areas

- **Coverage ratchets** — `validated %` rises as more driven states are captured
  into `captures/`; a low % means under-driven, not missing components.
- `captures/` + `report.html` + `audit.json` are gitignored (regenerable,
  app-dependent); the tool no-ops without them.
- Block-root mapping reuses `fe-inventory.blockRoot` + `_scan().defined` — stays
  correct as long as that lib is the single enumerator.

## Related

- [Shared FE enumerator: fe-inventory](../lib/fe-inventory.md)
- [Runtime capture: snapshot.js (?audit=2)](../../frontend/scripts/audit/snapshot.md)
- [Static gate: ui-doc-audit](ui-doc-audit.md)
- [Master runner: audit.sh](../shell/audit.md)
