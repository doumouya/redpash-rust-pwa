---
title: tools/lib/fe-inventory.js
source: ../../../../../tools/lib/fe-inventory.js
owner: Torv
section: Internal · Code · Tools · lib
last modified date: 2026-06-04
---

# fe-inventory

## Purpose

The single front-end **component enumerator**, shared by the doc generator
(`tools/doc-gen --components`) and the coverage audit (`tools/ui-doc-audit`) —
the "one extractor, every consumer" shape, same as [rust-routes](rust-routes.md)
for the route lane.

It exists because a **hand-curated** component list is the closed-enum trap: it
silently misses whatever the author forgot (the Cases-comments view, modals, the
omnisearch dropdown). Completeness has to be mechanical — enumerate every
component that exists *in the code* so nothing can be silently dropped. The
catalog + the coverage gate are only as complete as this enumeration.

## Public surface

- `inventory()` — `{ counts, components[], hooks[] }`. A **component** is a styled,
  structural group (anchored by a CSS-defined class → a catalog entry). A **hook**
  is a class used only in HTML/JS with no CSS rule and no defined ancestor (a
  one-off DOM handle — reported, never silently dropped, but not a catalog doc).
  Each group: `{ key, label, prefix, classes[], cssFiles[], partials[], jsFiles[],
  renderFns[], jsRendered }`.
- `cssSelectorIndex()` — `class → [{ file, selector }]`: every selector context a
  class appears in (the raw material for divergence detection + future page-delta).
- `divergences(selIndex)` — classes styled under ≥2 ancestor contexts (same name,
  divergent behavior, e.g. `.rp-chip-row` own + `.rp-cases-* .rp-chip-row`).
- `parallels(components, hooks)` — classes sharing a structural-role suffix across
  ≥2 blocks (`-head` in `rp-shell-head` + `rp-cases-detail-head` + `rp-modal-head`…)
  → candidates to compose into one atom.
- `analyze()` — one-shot `{ counts, components, hooks, divergences, parallels }`.
- CLI (inspection): `node tools/lib/fe-inventory.js [--json] [--hooks]`.

## How it works

- **Three sources** (union → complete): CSS class-families (`frontend/styles`),
  HTML usage (`frontend/partials` + `index.html`), JS-rendered widgets
  (`frontend/scripts`, recursive — the BLIND SPOT of a static scan: modals,
  comments list, pickers are injected by JS, not present in partials).
- **Token regex** anchored on the `rt-`/`rp-`/`ds-`/`ws-` prefixes; the separator is a
  single `-` or a BEM `__` join, so `--modifier` is stripped but `__element` is kept and
  tracked (`rp-page__title` folds to block `rp-page`; Profile/Settings use `__` heavily).
- **Grouping (flat / maximal grain):** each class folds to its BLOCK ROOT — climb
  to the top defined CSS class via repeated jumps to the longest defined PROPER
  ancestor (gap-skipping). So `rp-cases-detail-side-attachments-head` →
  `rp-cases-detail`, but `rp-cases-board` stays its own block (`rp-cases` is not a
  class). Distinct blocks stay distinct so parallels remain visible for the dedup
  detector to flag.

## Drift-prone areas

- **Grouping is a heuristic.** It depends on which intermediate classes happen to be
  CSS-defined; ~240 components today. A small reviewed overrides file (future) is the
  sanctioned escape valve for merge/split ambiguity — not a hand-list of components.
- **Render-fn attribution is file-level** in v1 (a component is "JS-rendered by" the
  render-roots in any file that emits one of its classes) — good enough to mark
  JS-rendered + name the producing functions; not precise function-body scoping.
- **Read-only, no deps** (vanilla Node, like the shell audits). The token regex
  assumes the kebab `rt-/rp-/ds-/ws-` convention; a class outside it is invisible.

## Related

- [tools/doc-gen/gen.md](../doc-gen/gen.md) — consumes this for `--components`.
- [tools/ui-doc-audit/audit.md](../audit-suite/ui-doc-audit.md) — the coverage gate + dedup.
- [rust-routes](rust-routes.md) — the sibling "one extractor, every consumer" lib.
