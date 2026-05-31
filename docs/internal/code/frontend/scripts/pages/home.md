---
title: frontend/scripts/pages/home.js
source: ../../../../../frontend/scripts/pages/home.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-05-31
---

# home.js

## Purpose

Home — the org command center. Shell pattern shared with Workspace: topbar + rail (LIST_VIEWS tabs) + body view. Per-tab list-views over Users / Memberships / Files / Companies / Charts / Cases / Projects. Composite-strip + chart cards opt-in per tab.

## Public surface

- Default export: page mount.
- Uses list-page.js for the shared paint path.
- Per-tab specs from pages/home/tabs.js.

## Drift-prone areas

- Pattern is LOCKED per pattern-lock-personalization-within; new tabs join via LIST_VIEWS entry.
- Post-fetchList hook order: `_decorateSelectMode` → `_applyColumnOrder` → `_applyHiddenColumns` → `_decorateEditMode`. The drag-reorder MUST land before positional hide indexing (otherwise hide hits the wrong columns) AND before edit-mode decoration (otherwise the spec's `editable: true` flag tags whatever column the user dragged into spec position N instead of the column the spec actually named). See [list-page.js](../list-page.md) for the underlying reorder contract.
- `decorateEditMode` resolves each editable col by its `data-col-key` on the LIVE thead — not by `spec.columns[i]` index — so a user's drag-reorder doesn't make the wrong cell editable.
- Which columns carry `editable: true` lives in each tab's LIST_VIEWS spec (lines ~287+ for Users etc.). The flag is only safe on TDs whose row template renders **plain text with no chip/pill markup**. Chip-wrapped cols would let contenteditable clobber the chip styling on save (deferred — needs the chip-cell-editor slice).
- **Data-full pattern for derived-display cols** (Cases `description` / `error_message`, Projects `description`, Users `username` with `@` prefix, any future `.slice()`-truncated or prefix-decorated TD that wants to be editable): the row template MUST carry `data-full="<source-of-truth>"` on the TD plus zero or more render rules. Today's render rules:
  - `data-trunc="<N>"` — `slice(0, N) || "—"` truncation ([runbook 0010](../../../runbooks/CAS_A5A432F1A82A4A4DB0B62C0085C4428C-cell-editor-data-full-pattern.md))
  - `data-prefix="<s>"` — `(prefix + full) || "—"` decoration ([runbook 0012](../../../runbooks/CAS_E97414C482AB431FA28D43392501F47B-cell-editor-data-prefix-and-chip-enum.md))

  `decorateEditMode` strips the rules on edit-on (textContent = bare `data-full`) and re-applies them on edit-off (textContent = composed display). `saveCellEdit` updates `data-full` after a successful PATCH so subsequent edits + the re-render read the fresh source. The mental model: `data-full` is the model, `textContent` is the view, render rules compose.
- **`editor: "chip-enum"` for finite-enum cols** (Users `plan` shipped 2026-05-31; future Cases `status` / `priority` / `type`, Memberships `role`, Projects `status`, Files `stage`): spec entry declares `editor: "chip-enum"`, `options: [...]`, `render: "<chipFunctionName>"`. `decorateEditMode` swaps the chip span for a `<select>` (built via `createElement`/`appendChild`, not innerHTML) on edit-on, restores the chip via `chipRenderFor(spec.render)(data-full)` on edit-off. `saveCellEdit` reads from `select.value` if a `select.rp-cell-edit-select` is present. New chip families add their renderer to the `chipRenderFor` dispatcher. The `change` event fires save immediately so picking an option lands the PATCH without waiting for blur. See [runbook 0012](../../../runbooks/CAS_E97414C482AB431FA28D43392501F47B-cell-editor-data-prefix-and-chip-enum.md).

## Related

- [Frontend pillar landing](../../../index.md)
