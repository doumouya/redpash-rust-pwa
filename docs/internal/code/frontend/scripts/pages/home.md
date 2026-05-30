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
- Post-fetchList hook order: `view._applyColumnOrder()` must fire before `view._applyHiddenColumns()` so the drag-reorder lands before positional hide indexing — see [list-page.js](../list-page.md).

## Related

- [Frontend pillar landing](../../../index.md)
