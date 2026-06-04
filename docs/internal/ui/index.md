---
title: UI Component Catalog
section: Internal
last modified date: 2026-06-04
---

# UI — the component catalog

The **component-first** view of the front end: document each UI component **once in
its fullest form**, then per page describe only the *delta* (which subset shows).
This kills the page-first duplication where the same component (RedTable, Rail,
TopBar) is re-described on every page it appears on.

The catalog is also the spine of a real **FE framework** and a **dedup instrument** —
laid down at maximal grain so duplicates (same-name-divergent-behavior classes,
parallel `-head`/`-title`/`-body` families) are impossible to miss.

## Shape

| Path | What | Source |
|---|---|---|
| [catalog/index.md](catalog/index.md) | the complete, code-enumerated component list + the dedup worklist | **generated** by `tools/doc-gen --components` |
| `catalog/<component>.md` *(future)* | one doc per component — fullest element inventory + human "why/how" | generated region + human prose |
| `pages/<page>.md` *(future)* | per-page composition + visibility delta (static + mode-gated) | generated region + human prose |

## Guarantees

- **Completeness is mechanical.** The denominator is enumerated from code by
  `tools/lib/fe-inventory.js`; `tools/ui-doc-audit` fails CI if a component is added
  without appearing in the catalog. No hand-curated component list (the closed-enum
  trap that silently drops components).
- **No clobber.** Generated regions (`<!-- doc-gen:component:* -->`) are owned by the
  tool; human prose around them survives regeneration (idempotent).

## Relationship to `code/`

This UI catalog (component axis) sits alongside [code/](../code/index.md) (one doc per
source *file*). Two complementary axes: the catalog answers "what is this component +
how does it look across pages"; the code docs answer "what does this file do". They
cross-link; neither duplicates the other.
