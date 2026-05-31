---
title: frontend/scripts/framework/editor-registry.js
source: ../../../../../frontend/scripts/framework/editor-registry.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-01
---

# editor-registry.js

## Purpose

Open registry of cell editors. Each editor module (`editor-text.js` / `editor-chip-enum.js` / `editor-entity-picker.js` / future / customer-supplied) registers itself on import via `editorRegistry.register({ id, buildOn, buildOff, readValue })`. Cell-editor (orchestrator) dispatches by `FieldDef.editor` id via `editorRegistry.lookup(id)`.

The FE side of the spec §5.1 contract: backend serves `editor` as an opaque string + never validates against an FE-known list. This registry is what makes that opacity safe: an unknown editor id silently downgrades to `text` (the universal fallback), so a customer's custom TypeDefinition with an unknown editor id never breaks the cell.

## Public surface

```js
import { editorRegistry } from "/scripts/framework/editor-registry.js";

editorRegistry.register({
  id: "<my-editor>",
  buildOn(td, ctx)  { /* activate edit-mode UI */ },
  buildOff(td, ctx) { /* restore display UI */ },
  readValue(td)     { /* read edited value for PATCH */ },
});

editorRegistry.lookup("<id>");  // → editor impl, falls back to "text"
editorRegistry.has("<id>");      // → boolean
editorRegistry.ids();            // → string[] of registered ids
```

## Editor impl contract (per spec §5.2)

- `id: string` — non-empty, unique within the registry. Registration with a duplicate id overwrites (used carefully; primarily for hot-reload).
- `buildOn(td, ctx)` — activate edit mode on a cell. Must mark the cell editable (.editable class) so the redtable's save-on-blur / save-on-change wiring fires.
- `buildOff(td, ctx)` — restore display UI. Must remove .editable + any editor-specific DOM the buildOn added.
- `readValue(td)` — return the value to PATCH. Caller may post-process (validate, transform) before issuing the API call.
- `ctx` — editor-specific options object (per-editor contract documented in that editor's atomic doc).

## Drift-prone areas

- **`text` fallback** — every framework consumer relies on `editor-text.js` being imported BEFORE any other editor module. If `text` isn't registered, `lookup()` returns `null` for unknown ids → cell becomes uneditable. cell-editor.js (the orchestrator) is responsible for ordering imports so `editor-text.js` lands first.
- **Contract enforcement** — `register()` throws if any of `id` / `buildOn` / `buildOff` / `readValue` is missing or wrong-shape. Customers writing editors get an immediate error at module-load time instead of a silent registry hole.
- **No backend coupling** — `register()` does NOT consult /admin/types or any wire shape; new editors register without backend deploy per spec §5.1 disposability rule.

## Status

Phase A shipped 2026-06-01. Built-ready, unwired per [[build-ready-dont-wire]].

## Related

- [framework/index](index.md) — landing.
- [TypeDefinition spec §5](../../../../specs/type-definition.md) — presentation contract.
- [editor-text](editor-text.md) — the universal fallback.
- [editor-chip-enum](editor-chip-enum.md) / [editor-entity-picker](editor-entity-picker.md) — other v1 editors.
- Cases: CAS_0FBF301F (TypeDefinition L0) / CAS_8A210C7A (cell-editor orchestrator, first consumer).
