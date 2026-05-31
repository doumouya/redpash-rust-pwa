---
title: frontend/scripts/framework/editor-text.js
source: ../../../../../frontend/scripts/framework/editor-text.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-01
---

# editor-text.js

## Purpose

The universal contenteditable editor + the framework's safety fallback. Registers `id: "text"` into [editor-registry](editor-registry.md). Every framework consumer falls back to this editor when `FieldDef.editor` is unknown — so a customer's TypeDefinition that names a not-yet-shipped editor never breaks the cell.

Semantics lifted from `pages/home.js` cell-editor closures (CAS_A5A4… data-full pattern) — same edit-mode UX, just dispatched through the framework registry.

## Public surface

Registers via side-effect on import:

```js
import "/scripts/framework/editor-text.js";
// editor-registry now serves an impl with id="text"
```

The impl conforms to the editor contract (per spec §5.2):

- `id: "text"`
- `buildOn(td)` — adds `.editable` + `contenteditable="plaintext-only"`. Expands `data-full` source-of-truth into the visible text so the user edits the bare string.
- `buildOff(td)` — strips `.editable` + contenteditable. Re-renders the display form using `data-trunc` (slice truncation) + `data-prefix` (display decoration) rules. Empty values render as `—`.
- `readValue(td)` — returns `td.textContent.trim()`.

## ctx contract

No `ctx` required. Reads `td.dataset.full / .trunc / .prefix` directly — those are the data attributes the row template stamps for any cell using the data-full pattern. Editors that need typed ctx (chip-enum, entity-picker) take it as the second buildOn arg.

## Drift-prone areas

- **data-full render rules** — `data-trunc` (slice length) + `data-prefix` (display prefix) are shared with `pages/home.js` cell-editor closures (today) and the future cell-editor.js orchestrator. Any change to those attribute names breaks both sites in lockstep.
- **Fallback role** — must be imported BEFORE any other editor module if the consumer wants the registry's universal fallback to work. cell-editor.js (when it lands) is responsible for the import order.

## Status

Phase A shipped 2026-06-01. Built-ready, unwired per [[build-ready-dont-wire]].

## Related

- [editor-registry](editor-registry.md) — where this registers.
- [home.js cell-editor (current consumer)](../pages/home.md) — the closure-form this replaces post-CAS_8A210C7A.
- Cases: CAS_0FBF301F / CAS_8A210C7A.
