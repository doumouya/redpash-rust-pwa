---
title: tools/uniformity-audit/audit.js
source: ../../../../../tools/uniformity-audit/audit.js
owner: Torv
section: Internal · Code · Tools · uniformity-audit
last modified date: 2026-06-05
---

# uniformity-audit/audit.js

## Purpose

The **uniformity guard** — the standing check that would have caught SheetWise's
`sw-*` fork on day one. It fails when a *railed* page introduces a class whose
**family** (the prefix before the first `-`) is not a sanctioned framework /
positioning family. The 24h `rt-*`→`rp-*` dedup removed duplicates but installed
no guard, so the first page built in a hurry re-forked a parallel vocabulary;
this turns "compose `rp-*` atoms, don't fork a family" from a habit into a gate.

## How it works

- Scans `frontend/partials/*.html` + `frontend/scripts/pages/*.js` (class attrs +
  `className` strings + `classList.add/remove/toggle`). `login` is excluded — it's
  a centered card page, divergent by design, not a railed shell.
- **Family gate:** a hyphenated class whose family ∉ `ALLOW_FAMILY`
  (`rp` / `bi` / `is` / `has` / `tok` / `ws` / `ds` / `mode`) is a violation.
  Bare classes (no hyphen — `open` / `active` / `nul`, states/utilities) are skipped.
- **Baseline ratchet** (`baseline.json`): the current follow-on backlog (the
  `rt-*` legacy tail in cases/workspace/home) is locked as *known*; only classes
  NOT in the baseline are NEW and FAIL (exit 1). `--baseline` rewrites the lock
  (regenerate after a rollout slice retires part of the tail, to prune it).

## Scope — what it does NOT do (deliberately)

It is a **family** gate, not a role-dup gate. It does not chase an `rp-`-prefixed
re-skin (`rp-profile__id-btn` re-skinning `rp-btn`): a static "class embeds a role
word" test false-positives massively on legit positioning (`rp-cases-rail-source`,
`rp-seg--rail`, `rp-cases-chip-row` all embed role words but are correct). That
semantic call belongs to the periodic **agent** uniformity audit. Keeping this
gate PRECISE (zero false positives) is what makes it trustworthy.

## Usage

```
node tools/uniformity-audit/audit.js            # gate: exit 1 on any NEW foreign family
node tools/uniformity-audit/audit.js --baseline # re-lock the current backlog
```
Auto-discovered + run by `sh tools/audit.sh` (the `tools/*-audit/` glob).

## Drift-prone areas

- **Adding a family to `ALLOW_FAMILY` is a reviewed act** — that's the point. A new
  page-positioning family (a future `rp-`-peer) is added here deliberately; a fork
  (`sw-*`) is not, so it fails until it composes atoms.
- **Baseline staleness:** when a rollout slice removes `rt-*` classes, their
  baseline keys go stale (harmless — they just match nothing). Re-run `--baseline`
  periodically to prune, so the backlog count reflects reality.

## Related

- [audit.sh](../shell/audit.md) — the suite runner that discovers this.
- Plan: SheetWise conform + this guard (`hi-need-a-plan-golden-treasure.md`).
