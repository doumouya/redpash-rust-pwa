---
title: Internal · Code · Backend — atomic docs for backend/crates/
section: Internal · Code · Backend
order: 1
last modified date: 2026-05-30
---

# Backend — atomic docs

One doc per `.rs` file under `backend/crates/{api,data,shared}/src/`.
Mirror layout — drop `crates/` and `src/` so the doc tree reads
naturally: `backend/crates/api/src/routes/files/joins.rs` →
[`backend/api/routes/files/joins.md`](api/).

**Coverage at baseline (2026-05-30):** 80 atomic units, 0 documented.
Phase B (per the [plan](../../processes/atomic-doc-plan.md)) walks
this up — order: `shared/` → `data/` → `api/` with `routes/` last.

## Crates

| Crate | Files | Atomic docs | Role |
|---|---|---|---|
| [api](api/) | 9 root + 25 routes + 6 db + 2 bin = 42 | _to come_ | Axum HTTP server, route modules per resource |
| [data](data/) | 13 root + 3 parse + 6 steps = 22 | _to come_ | Polars-backed compute layer; CSV parse, cleaning-step replay, group-by engine |
| [shared](shared/) | 16 | _to come_ | DTOs that travel over the wire — pure types, no logic |

## Reading order for new contributors

1. [`shared/lib.md`](shared/) — what the wire shapes are
2. [`api/main.md`](api/) — how the server boots
3. [`api/state.md`](api/) — `AppState`: db pool, file cache, OAuth config
4. [`api/routes/mod.md`](api/) — Router assembly + middleware
5. [`data/parse/mod.md`](data/) — CSV → DataFrame entry points
6. [`data/steps/mod.md`](data/) — cleaning-step replay dispatcher

(stubs land in Phase B's first commit; deep-fill is incremental)

## Related

- [Cross-tier crossings](../../../subsystems/api-crossings.md) — when an `api/routes/foo.rs` ← `frontend/scripts/pages/foo.js` pair drifts, `tools/crossing-audit` catches it
- [Public REDMAP — backend section](../../../../REDMAP.md) — one-screen architectural map
- [`api/routes/` index](api/routes/) — route table
