---
title: Step apply + replay
section: Internal
order: 42
last modified date: 2026-05-24
status: stub
---

# Flow: Step apply + replay

> **TODO.** Fill from a workspace-side and step-engine-side joint walk.

To cover:

- `applyStep(kind, params)` in workspace.js — single-flight gate, rowsInfo status, response consume
- POST `/api/files/:rid/steps` → `add_step` → step row inserted with `applied: true` + ordinal
- Engine hydrate path: next read replays all applied steps against the base frame
- Undo: walk the topmost `applied: true` step, flip to `false`, return rebuilt envelope
- Redo: walk the topmost `applied: false` step, flip to `true`
- `set_cell` + `drop_rows` — the cell-edit / row-delete handlers in workspace.js use the same step path
- Snapshot vs replay — when the engine materialises (perf bound)

See also: [subsystems/step-engine.md](../subsystems/step-engine.md), [architecture/js-rust-boundary.md](../architecture/js-rust-boundary.md).
