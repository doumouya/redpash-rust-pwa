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
- **Data-full pattern for truncated cols** (Cases `description` / `error_message`, Projects `description`, any future `.slice(0, N)`-truncated TD that wants to be editable): the row template MUST carry `data-full="<source-of-truth>"` and `data-trunc="<N>"` on the TD. `decorateEditMode` swaps `textContent` to `data-full` on edit-mode ON, re-truncates from `data-full.slice(0, data-trunc)` on edit-mode OFF, and `saveCellEdit` updates `data-full` after a successful PATCH so subsequent edits + the re-truncate read the fresh value. Without `data-full`, the cell-editor PATCHes the truncated *display* string back to the backend, silently losing the tail — that's the data-loss bug class avoided by the contract. See [runbook 0010](../../../runbooks/CAS_A5A432F1A82A4A4DB0B62C0085C4428C-cell-editor-data-full-pattern.md).

## Related

- [Frontend pillar landing](../../../index.md)
