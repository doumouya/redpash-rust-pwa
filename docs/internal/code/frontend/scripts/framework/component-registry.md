---
title: frontend/scripts/framework/component-registry.js
source: ../../../../../../frontend/scripts/framework/component-registry.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-14
---

# component-registry.js

## Purpose

The **UI-component registry** — sibling to [editor-registry](editor-registry.md) (cell
editors) and [type-registry](type-registry.md) (TypeDefinitions). This one registers whole
**components** (redtable, rail, create-action, …) so a single implementation of each is
consumed by every page, and a change to one — how a row renders, dropping pagination —
propagates to every consumer at once. The spine of the framework-extraction epic
CAS_37B2E1BF (child of CAS_9E4F134B): 6 RedTable impls / 4 rails / 4 create-actions → one each.

## Public surface

- `register(name, factory)` — a component module self-registers its factory (throws on
  duplicate / non-function). Returns the factory.
- `get(name)` — the registered factory, or `null`.
- `list()` — sorted registered names; the sandbox + `tools/ui-runtime-audit` read this to
  measure framework coverage.

ESM: `import { register } from "/scripts/framework/component-registry.js"`.

## How it works

- Component modules import this and self-register at load: `register("redtable", createRedTable)`.
- `frontend/framework-sandbox.html` imports the registry + the component modules and rebuilds
  the 7 real pages from registered components — the completeness proof.
- `tools/ui-doc-audit`'s namespace lint enforces `rp-` flat-kebab (no `__`/`rt-`/`ds-`/`ws-`)
  across `framework/`; the framework is complete when every enumerated component is sourced here.

## Drift-prone areas

- **`framework/` also holds the cell-editor / TypeDefinition primitives** (see the
  [framework index](index.md)). This registry coexists; the cell-editor should `register()`
  here once it consumes the component pattern. Its lone `rt-table` ref is allowlisted in the
  lint until the RedTable slice migrates it.
- Components must register at module load; the sandbox/audit only see registered factories.

## Related

- [framework index](index.md) — the dir overview (TypeDefinition primitives + these components).
- `frontend/framework-sandbox.html` — the completeness harness.
- [tools/ui-doc-audit](../../../tools/audit-suite/ui-doc-audit.md) — namespace lint + coverage gate.
- Epic CAS_37B2E1BF.
