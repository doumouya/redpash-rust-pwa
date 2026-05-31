---
title: frontend/scripts/framework/cell-editor.js
source: ../../../../../frontend/scripts/framework/cell-editor.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-01
---

# cell-editor.js

## Purpose

The redtable cell-editor orchestrator. Walks editable cells in a view, dispatches edit-mode on/off to the [editor-registry](editor-registry.md), and exposes a `save()` helper that uses the resolved editor's `readValue()` before issuing the PATCH. Page-specific state (`editHistory` / `editFuture` / `logAction` / per-tab reset) stays in the CALLER — this module is stateless.

Extracted from `pages/home.js` `decorateEditMode` + `saveCellEdit` closures per CAS_8A210C7A. Semantics preserved (CAS_A5A4… data-full pattern + CAS_E97414… chip-enum + CAS_D78667D1 per-column editEndpoint); the framework version takes a `chipRender(name) → fn` callback so the chip vocabulary stays in the caller until the chip-registry extraction (CAS_BF208AA8) lands.

## Public surface

```js
import { cellEditor } from "/scripts/framework/cell-editor.js";

cellEditor.decorate({
  view,                 // DOM root
  spec,                 // page spec (columns[].editKey/editor/options/render/...)
  editMode,             // boolean — activate or strip
  selectMode,           // boolean — leading sel-column offsets TD index by +1
  isPlatformAdmin,      // boolean — gates col.requiresAdmin
  chipRender,           // fn(name) → fn(value) → htmlString  (chip vocabulary)
});

const result = await cellEditor.save({
  td,                   // edited cell
  rid,                  // row's rid
  spec,                 // for col.editEndpoint resolution
  api,                  // fetch wrapper (e.g. /scripts/api.js#api)
});
// result = { key, value, oldValue } on success
// result = null on no-op (value unchanged)
// throws on PATCH failure (caller handles revert + UI)
```

### decorate({ view, spec, editMode, isPlatformAdmin, chipRender })

Two phases:

1. **STRIP** — every `.editable` cell exits edit mode via its editor's `buildOff`. Run unconditionally so toggling `editMode` off cleanly restores display. Removes `data-edit-key` (orchestrator's concern, not the editor's).
2. **ACTIVATE** (only when `editMode === true`) — walks spec's editable columns, resolves each TD by the CURRENT thead position (survives column reorder), dispatches `buildOn` per editor id.

### save({ td, rid, spec, api })

- Resolves the editor by `col.editor`, reads the value via `editor.readValue(td)`.
- Bails on no-op (`value === td.dataset.editOriginal`).
- Resolves PATCH base via `col.editEndpoint` → `spec.patchEndpoint` → `spec.endpoint` (CAS_D78667D1).
- Updates `td.dataset.editOriginal` + `td.dataset.full` (source-of-truth maintenance).
- Returns `{ key, value, oldValue }` so the caller can push to its undo stack + log.

## ctx contract delegated to editors

Per spec §5.2, each editor consumes a `ctx` shaped to its needs. `decorate` builds ctx per col:

| `col.editor`     | ctx provided                                              |
|------------------|-----------------------------------------------------------|
| `text` (default) | `{}` — text editor reads `td.dataset.full / .trunc / .prefix` directly. |
| `chip-enum`      | `{ options: col.options, renderChip: chipRender(col.render) || undefined }` |
| `entity-picker`  | `{ relType: col.rel?.type, placeholder: col.placeholder, renderChip: chipRender(col.render) || undefined }` — `renderChip` (like chip-enum's) rebuilds the display chip on the OFF re-render, applied to the cell's `data-label`. Wired 2026-06-01 with the first real consumer (Users-tab Org, `relType: "company"`). |

Unknown `col.editor` IDs fall back to `text` via the editor-registry's universal fallback (spec §5.1).

## Drift-prone areas

- **chipRender callback** — present-day bridge to `pages/home.js#chipRenderFor`. When CAS_BF208AA8 lands, the caller registers chips into a future `framework/chip-registry.js` + this module looks them up directly; the callback param goes away. Coordinated change.
- **#rp-home-list-tbody selector** — currently hard-coded (matches the existing home.js redtable shell). A future generic `list-page.js` will lift this selector into spec/ctx; for now it's tied to the Home shell.
- **thead column resolution** — relies on `th[data-col-key]` to map field keys to TD positions. The redtable column-reorder code is the source of those attributes; any change there breaks decorate.
- **selectMode offset** — the `.rt-mode[data-mode="select"]` element + leading sel-column convention is shared with home.js's redtable shell. Same future-lift target as #rp-home-list-tbody.

## Status

Phase B shipped 2026-06-01 by replacing home.js's decorateEditMode + saveCellEdit closures with `cellEditor.decorate` + `cellEditor.save` calls. Edit history / undo / action log stay in home.js as caller-side state.

## Related

- [framework/index](index.md) — landing.
- [editor-registry](editor-registry.md) — dispatch target.
- [editor-text](editor-text.md) / [editor-chip-enum](editor-chip-enum.md) / [editor-entity-picker](editor-entity-picker.md) — v1 editor inventory.
- [home.js](../pages/home.md) — caller; owns chip vocabulary + undo stack + action log.
- Cases: CAS_0FBF301F (parent) / CAS_8A210C7A (this slice) / CAS_BF208AA8 (chip-render hardening, follow-on) / CAS_D78667D1 (per-column editEndpoint, semantics preserved here).
