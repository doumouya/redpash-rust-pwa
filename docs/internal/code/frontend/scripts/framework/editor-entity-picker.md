---
title: frontend/scripts/framework/editor-entity-picker.js
source: ../../../../../frontend/scripts/framework/editor-entity-picker.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-01
---

# editor-entity-picker.js

## Purpose

Cell editor for rid fields whose data_type is `rid` and whose FieldDef carries a `rel: { type, multi }` pointer (e.g. `case.assignee_id` → user, `file.project_id` → project). Picks a related entity **by name** and resolves it to its **rid** for the PATCH. Registers `id: "entity-picker"` into [editor-registry](editor-registry.md).

The cell carries two attrs: `data-full` = the current **rid** (the PATCH value / source of truth, what `save()` syncs), `data-label` = the current **display name** (picker pre-fill + the OFF re-render).

**WIRED 2026-06-01** — the first real consumer landed (Users-tab "Org" editing, `relType: "company"`, Em request), so the search wiring shipped against a real UX per [[build-ready-dont-wire]]. Companies are a small set, so a native `<datalist>` autocomplete fits — no debounced server search needed yet. The per-relType `SOURCES` map drives the fetch + `{rid,name}` extraction; only `company` is populated (the wired consumer). An **unknown relType** falls back to a bare text input (rid typed, backend validates) — still build-ready for the next consumer (e.g. `user`), which adds its `SOURCES` row and can swap to debounced search without touching any consumer.

## Public surface

Registers via side-effect on import:

```js
import "/scripts/framework/editor-entity-picker.js";
// editor-registry now serves an impl with id="entity-picker"
```

The impl:

- `id: "entity-picker"`
- `buildOn(td, ctx)` — replaces the cell's children with an `<input.rp-cell-edit-input>` pre-filled with `data-label` (the name). For a relType in `SOURCES`, links a shared `<datalist>` (lazy-fetched once, cached) and, on each `input` event, resolves the typed name → rid (`input.dataset.rid`) and updates `data-label` so a post-save exit re-renders the new name. Unknown relType → bare input.
- `buildOff(td, ctx)` — removes `.editable`; renders `data-label` via `ctx.renderChip` (the dev renderer, e.g. `orgChip`) when present, else as text. **Security:** `renderChip` MUST escape its input — `data-label` is user-writable free text (a company name); see CAS_BF208AA8 (the string→DOM-node hardening).
- `readValue(td)` — returns the **resolved rid** for the picked name (via the cached `byName` map), or `input.dataset.rid`, or the original `data-full` — never a bare typed string, so a no-match is a safe no-op (the backend also 404s an unknown rid).

## SOURCES (per-relType wiring)

Module-level map: `relType → { url, extract(page) → [{rid, name}] }`. Lazy-fetched once per session, cached as a `byName: Map<name,rid>`. Only `company` is wired (`/admin/companies?size=500`, fields flat on the row). Add a row when the next real consumer lands — don't speculate shapes ahead of need.

## ctx contract

| key           | type                          | purpose |
|---------------|-------------------------------|---------|
| `relType`     | `string`                      | the type id this picker resolves against (matches `FieldDef.rel.type`). Drives the `SOURCES` lookup; wired types autocomplete, others get a bare input. |
| `placeholder` | `string`                      | optional input placeholder. |
| `renderChip`  | `(label: string) => string`   | dev renderer (resolved from `chipRenderFor` + `col.render`) used on buildOff over `data-label`. MUST escape its input. When omitted, text fallback. |

## Drift-prone areas

- **`<datalist>` vs debounced search** — the company wiring uses a native `<datalist>` (fetch-all-once), right for a small set. A large set (`user`, thousands) wants a debounced `/api/<type>?q=` search + a custom dropdown; that swaps in at the `SOURCES`/`buildOn` layer when that consumer lands, without changing the `ctx`/`readValue` contract consumers rely on.
- **`size=500` cap** — the company fetch passes `?size=500`; if `paginate` clamps lower and there are more companies than the cap, the datalist is incomplete (acceptable for the current small set; revisit with the debounced-search swap).
- **`data-full` = rid, `data-label` = name** — the cell MUST carry both for the picker (rid is the PATCH value, name is the display). `save()` syncs `data-full` to the picked rid; `data-label` is updated by the `input` handler on a valid pick. A consumer that only sets `data-full` (no label) gets a bare-rid display on a no-save exit.
- **Validation** — `readValue` never returns a typed string; a no-match falls back to the original rid (no-op). The backend re-validates the rid (404 on unknown) as the final guard.
- **multi=true** — single-rid only. `multi: true` rels (e.g. case.watchers) land as a separate editor when a consumer needs it.

## Status

Shipped build-ready 2026-06-01 (Phase A), **wired for `company` the same day** as the first real consumer (Users-tab Org editing). Verified via a Playwright component + integration smoke (datalist populated, name→rid resolution, garbage→safe no-op, full `cellEditor.save` → PATCH `/admin/users` → membership swap → restore).

## Related

- [editor-registry](editor-registry.md) — where this registers.
- [home.js cell-editor (current consumer)](../pages/home.md) — the closure-form this replaces post-CAS_8A210C7A.
- Cases: CAS_0FBF301F / CAS_8A210C7A.
