---
title: frontend/scripts/dropdown.js
source: ../../../../frontend/scripts/dropdown.js
owner: Torv
section: Internal · Code · Frontend · scripts
last modified date: 2026-06-05
---

# dropdown.js

## Purpose

One delegated click handler for the [data-dd] + .rt-dd / .rp-menu dropdown atom. Replaces the mount-time $$([data-dd]) sweep in workspace.js (only caught statically-rendered buttons) + the inline workaround in report.js.

## Public surface

- bindDropdown() — single delegated document handler (module-level singleton, idempotent), called once at app boot in main.js.
- Trigger click toggles the panel (resolved by `document.getElementById(btn.dataset.dd)` — class-agnostic), mutex-closes others, and outside/item click closes all open panels.

## Drift-prone areas

- Atom contract: [data-dd] button + a panel element whose `id` matches `data-dd`. The OPEN is id-based (class-agnostic), but the mutex + outside-click CLOSE is class-based.
- **Design-language migration (2026-06-05, CAS_B747F2B6):** the close-selector targets BOTH `.rt-dd.open` (legacy — list-page rows menu, home actions) AND `.rp-menu.open` (migrated — workspace data toolbar, report-builder group/pivot, the multi-column picker). A panel that emits only one of the two still opens (id-based) but would not outside-click-close if the selector dropped its atom — keep both until the last `.rt-dd` consumer (list-page / home) adopts `rp-menu`, then drop the legacy half (Phase C).

## Related

- [Frontend pillar landing](../../index.md)
