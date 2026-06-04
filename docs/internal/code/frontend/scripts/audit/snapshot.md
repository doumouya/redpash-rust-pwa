---
title: frontend/scripts/audit/snapshot.js
source: ../../../../../frontend/scripts/audit/snapshot.js
owner: Torv
section: Internal · Code · Frontend · scripts/audit
last modified date: 2026-06-04
---

# snapshot.js

## Purpose

When the SPA loads with ?audit=1, every page mount triggers captureSnapshot() — walks the rendered DOM, captures getComputedStyle() for the foundation-atom catalog AND (v3, 2026-06-04) the **full rendered class inventory** of the live DOM, and downloads a JSON file. Output feeds tools/ui-snapshot-audit/audit.js for ingest. The full inventory is what the object-map / UI-proposition confirmation needs: it sees JS-built and `display:none`-present components that static CSS/partials parsing can't.

## Public surface

- `captureSnapshot(state)` — DOM walk + computed-style harvest (atom catalog) + **full class inventory**. Returns `{route, theme, state, atoms, classes:[…], class_counts:{…}}`.
- `collectClasses()` — walks `document.body` (catches modal/dropdown portals), returns `{class: instanceCount}` for every rendered class.
- `downloadSnapshot(snapshot)` — JSON download named per route/theme/state.
- Foundation-atom catalog + tracked computed-style props live inline.

## Drift-prone areas

- Atom catalog (computed-style half) must stay in sync with frontend/styles/ foundation atoms; new atoms need adding here to be captured. The **class inventory** half is catalog-free — it captures whatever the DOM renders.
- `classes`/`class_counts` are the new fields (v3); old snapshots lack them — ui-snapshot-audit defaults to `[]` (back-compat).
- Virtualized lists (virtual-rows.js) mount only the ~visible window — the class SET is complete, but `class_counts` reflect only mounted rows.

## Related

- [Frontend pillar landing](../../../index.md)
