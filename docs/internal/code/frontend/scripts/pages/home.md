---
title: frontend/scripts/pages/home.js
source: ../../../../../frontend/scripts/pages/home.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-05-30
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

## Related

- [Frontend pillar landing](../../../index.md)
