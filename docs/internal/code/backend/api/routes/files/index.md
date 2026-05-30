---
title: Internal · Code · Backend · api/routes/files — atomic docs
section: Internal · Code · Backend · api · routes · files
order: 3
last modified date: 2026-05-30
---

# api/routes/files — atomic docs

The largest resource in the API — files upload, page reads, cleaning
steps, joins, stats, snapshots. Decomposed 2026-05-27 from a single
monolithic `files.rs` into per-concern submodules with re-exports at
the parent `files::*` so call sites stayed frozen.

**Coverage at baseline (2026-05-30):** 6 atomic units, 0 documented.

## Files

| File | Atomic doc | Role |
|---|---|---|
| `mod.rs` | [mod.md](mod.md) | router wiring + upload + page + steps + undo/redo + encoding |
| `joins.rs` | [joins.md](joins.md) | `GET /joins` detect + `POST /joins` apply |
| `stats.rs` | [stats.md](stats.md) | `/dedup` + `/uniques` + `/sentinels` + `/cleanness` |
| `output.rs` | [output.md](output.md) | `/snapshot` + `/export` |
| `meta.rs` | [meta.md](meta.md) | `PATCH /:rid` + `DELETE /:rid` + display-name/move/encoding |
| `state_ops.rs` | [state_ops.md](state_ops.md) | `/cast-preview` + `/clear-filters` + cleaner cursor ops |

## Related

- [Routes landing](../index.md)
- [Subsystem: step-engine](../../../../../subsystems/step-engine.md)
- [Flow: csv-upload-to-render](../../../../../flows/csv-upload-to-render.md)
- [Flow: step-apply-and-replay](../../../../../flows/step-apply-and-replay.md)
