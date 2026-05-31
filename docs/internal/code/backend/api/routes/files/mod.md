---
title: backend/crates/api/src/routes/files/mod.rs
source: ../../../../../../../backend/crates/api/src/routes/files/mod.rs
owner: Gus
section: Internal · Code · backend · api · routes · files
last modified date: 2026-05-31
---

# mod.rs

## Purpose

`/api/files/*` — upload, summary, paged rows, steps.

Persistence model:
• Bytes      → `<data_dir>/files/<rid>.bin` (immutable).
• Metadata   → `project_files` row.
• History    → `project_steps` rows (append-only, `applied` toggled
by undo/redo, redo stack cleared on new step).
• Hot frame  → in-memory cache; cache miss replays all applied
steps on top of the freshly-parsed base.

## Public surface

- `pub fn routes` — function

## Gates

- `get_summary` / `get_page` — `file.view` (cascade file→project→company).
- `patch_file` / `delete_file` / `add_step` — `require_grant`,
  `effective() >= Admin` (owner via project `scope` `Owner`; project/company
  admin via cascade; platform). A file has no direct membership — ownership
  flows User→Project→File, so `effective` (not `is_member`) captures the owner.
  Applying a cleaning step (`add_step`) is a content mutation gated like update.
  The `patch_file` move (`project` change) stays double-gated on the destination.
  `patch_file` then **field-gates** via `field_perms::require_fields(.., "file", ..)`
  (CAS_C4219F2B s3) — narrows per field via the matrix.
- `upload` (create) — gated on the destination project.

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../../index.md)
