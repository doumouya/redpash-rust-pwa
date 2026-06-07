---
title: Stack — internal
section: Internal
last modified date: 2026-06-07
---

# Stack

The **code explanation at system granularity** — how each layer works under
the hood. This is the per-subsystem prose; the per-FILE deep dives live in the
[code](../code/index.md) survival layer (linked from each page's *Source
files*).

> Migrating in (CAS_701CF65E): folds the old `subsystems/*` + the FE/shell
> patterns from `architecture/*` + the public `docs/dev/*` + `docs/frontend/*`.
> Phase C.

## Layers

- [frontend.md](frontend.md) — vanilla-JS PWA shell, the JS↔Rust boundary
  (Rust owns data, JS owns pixels), the rail-shell pattern, the `rp-*`
  framework atoms, prefs/SWR. (folds `architecture/js-rust-boundary`,
  `architecture/ui-shell-pattern`, `subsystems/prefs`, `subsystems/workspace-shell`)
- [backend.md](backend.md) — axum / sqlx / polars; the route layer, the data
  engine, the step engine, events + audit storage. (folds `subsystems/api-routes`,
  `data-engine`, `step-engine`, `events-and-logs`, `audit-storage`)
- [tools.md](tools.md) — the audit suite, `doc-gen`, `page-verify`, the team
  coordination tools.
- [db.md](db.md) — Postgres posture, the RedPash-ID scheme, migrations. (folds
  `docs/db/redpash-id.md`)

## Deep per-subsystem prose

Larger subsystems (data engine, wasm engine, omnisearch) may keep a dedicated
`stack/<system>.md` rather than folding into the four above — whichever reads
clearer. Each ends with a **Source files** section into [code/](../code/index.md).
