---
title: frontend/scripts/framework/editor-chip-enum.js
source: ../../../../../frontend/scripts/framework/editor-chip-enum.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-01
---

# editor-chip-enum.js

## Purpose

Cell editor for enum-data_type fields whose display form is a chip. Swaps the chip span for a `<select>` populated with the field's enum options on edit-mode-on; rebuilds the chip via a caller-supplied `renderChip` function on edit-mode-off. Registers `id: "chip-enum"` into [editor-registry](editor-registry.md).

Semantics lifted from `pages/home.js` cell-editor chip-enum branch (CAS_E97414…) — same edit-mode UX, with the chip-render dispatch pulled out as a `ctx.renderChip` callback so the editor stays vocabulary-agnostic (no hardcoded chip kinds; customer-added chip families plug in via the same ctx contract).

## Public surface

Registers via side-effect on import:

```js
import "/scripts/framework/editor-chip-enum.js";
// editor-registry now serves an impl with id="chip-enum"
```

The impl:

- `id: "chip-enum"`
- `buildOn(td, ctx)` — replaces the cell's children with a `<select.rp-cell-edit-select>` populated from `ctx.options`. Pre-selects `td.dataset.full` if it's in options.
- `buildOff(td, ctx)` — removes `.editable`. If `ctx.renderChip` is a function, calls it with `td.dataset.full` and assigns the returned HTML to `td.innerHTML` (see SECURITY CONTRACT below). Otherwise falls back to `td.textContent = data-full || "—"` (safe textContent path used by tests).
- `readValue(td)` — returns `select.value` (never `textContent`; the chip's option label and option value are not guaranteed identical).

## ctx contract

| key          | type                         | purpose |
|--------------|------------------------------|---------|
| `options`    | `string[]`                   | enum options to populate `<select>` from. Required for `buildOn` to do anything useful. |
| `renderChip` | `(value: string) => string`  | called with `data-full` on buildOff; returns HTML string for the cell's rebuilt chip. When omitted, buildOff uses textContent fallback (safe by construction). |

## SECURITY CONTRACT

`buildOff` uses `td.innerHTML = ctx.renderChip(value)` when a renderer is supplied. **Renderers MUST escape their input value before returning HTML.** The chip renderers in `pages/home.js` (`planChip` / `caseStatusChip` / `orgChip` / `stageChip` / `priorityChip` / `caseTypeChip` / `teamKindChip` / default) all route values through `esc()` or dev-controlled HTML templates; backend-served enum values like `"active"` / `"urgent"` are non-malicious by source. Defense-in-depth wants this contract enforced structurally instead of contractually — tracked as CAS_BF208AA8 (switch chip renderers to return DOM nodes instead of HTML strings; bundled with cell-editor extraction CAS_8A210C7A).

The no-renderer branch uses `td.textContent` — safe by construction, used by tests + the §6 acceptance smoke before chip-render lands.

## Drift-prone areas

- **chip-render contract** — `ctx.renderChip` is a string-returning function today; future hardening (CAS_BF208AA8) switches it to a DOM-node-returning function + this module's buildOff to `appendChild`. Coordinated change.
- **Select markup** — `.rp-cell-edit-select` class is shared with the existing home.js cell-editor; CSS for the swap chip-vs-select lives in `frontend/styles/` and must stay aligned.

## Status

Phase A shipped 2026-06-01. Built-ready, unwired per [[build-ready-dont-wire]].

## Related

- [editor-registry](editor-registry.md) — where this registers.
- [home.js cell-editor (current consumer)](../pages/home.md) — the closure-form this replaces post-CAS_8A210C7A.
- Cases: CAS_0FBF301F / CAS_8A210C7A / CAS_BF208AA8 (chip-render hardening).
