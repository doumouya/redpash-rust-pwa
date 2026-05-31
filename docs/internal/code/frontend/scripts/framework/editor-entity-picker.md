---
title: frontend/scripts/framework/editor-entity-picker.js
source: ../../../../../frontend/scripts/framework/editor-entity-picker.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-01
---

# editor-entity-picker.js

## Purpose

Cell editor for rid fields whose data_type is `rid` and whose FieldDef carries a `rel: { type, multi }` pointer (e.g. `case.assignee_id` → user, `case.reporter_id` → user, `file.project_id` → project). Registers `id: "entity-picker"` into [editor-registry](editor-registry.md).

Phase A status: **BUILD-READY, NOT WIRED** per [[build-ready-dont-wire]]. The text-input scaffold + reads-from-input behavior is shipped; the search + autocomplete machinery (debounced `/api/<type>?q=` calls, dropdown DOM, keyboard navigation) is intentionally NOT in this module — it lands when the first real consumer (cell-editor.js dispatching for case.assignee editing) needs it. Adding it now would speculate against an unwritten UX; lifting it from a real consumer when one exists keeps the design honest.

## Public surface

Registers via side-effect on import:

```js
import "/scripts/framework/editor-entity-picker.js";
// editor-registry now serves an impl with id="entity-picker"
```

The impl:

- `id: "entity-picker"`
- `buildOn(td, ctx)` — replaces the cell's children with an `<input.rp-cell-edit-input>` pre-filled with `data-full`. Stamps `ctx.placeholder` + `ctx.relType` onto the input.
- `buildOff(td, ctx)` — removes `.editable`. If `ctx.renderRid` is a function, calls it with `data-full` to get the display string (e.g. resolve a USR_ rid to a display_name). Otherwise renders the bare rid (or `—`).
- `readValue(td)` — returns the input's trimmed value, or `data-full` when no input is present.

## ctx contract

| key           | type                       | purpose |
|---------------|----------------------------|---------|
| `relType`     | `string`                   | the type id this picker resolves against (matches `FieldDef.rel.type`, e.g. `"user"`, `"project"`). Stamped as `input.dataset.relType` for future search wiring. |
| `placeholder` | `string`                   | optional input placeholder. |
| `renderRid`   | `(rid: string) => string`  | called with `data-full` on buildOff to produce the display string (e.g. user display_name lookup). When omitted, the rid itself renders. |

## Drift-prone areas

- **Search wiring** — when the real consumer surfaces, debounce + dropdown + keyboard nav lives in the wiring-time commit (not retrofitted onto this module). The buildOn scaffold accepts the wiring without re-shaping; the wiring is its own slice.
- **Validation** — `readValue` returns a bare string. The caller must validate that the entered value matches a rid for `ctx.relType` before issuing the PATCH (backend returns 404 on a missing rid per spec §4.2, so an invalid rid round-trips visibly — but a typo-friendly UX wants pre-PATCH validation).
- **multi=true** — v1 supports single-rid only. `multi: true` rels (e.g. case.watchers) land as a separate editor (`editor-entity-multi`) when the first real consumer needs it.

## Status

Phase A shipped 2026-06-01. Built-ready, unwired per [[build-ready-dont-wire]] (with the wiring intentionally deferred to the first real consumer).

## Related

- [editor-registry](editor-registry.md) — where this registers.
- [home.js cell-editor (current consumer)](../pages/home.md) — the closure-form this replaces post-CAS_8A210C7A.
- Cases: CAS_0FBF301F / CAS_8A210C7A.
