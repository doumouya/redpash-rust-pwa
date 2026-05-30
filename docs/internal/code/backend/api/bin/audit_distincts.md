---
title: backend/crates/api/src/bin/audit_distincts.rs
source: ../../../../../../backend/crates/api/src/bin/audit_distincts.rs
owner: Gus
section: Internal · Code · backend · api · bin
last modified date: 2026-05-30
---

# audit_distincts.rs

## Purpose

`redpash-audit-distincts` — measurement walk for the column-index
design (Torv ↔ Gus, Internal-Slack 2026-05-24).

Walks every CSV-typed file in `project_files`, parses it from disk,
and for every column computes the distinct-value set using the
existing `data::joins::unique_per_col(df, MAX_UNIQUE)` primitive
(same cap the autocomplete endpoint will use). Records per-file
stats + prints a distribution summary so the architecture decisions
(LRU bound, eager-vs-lazy preload, all-cols-vs-per-col endpoint,
whether MAX_UNIQUE=5000 is enough) land on data, not a guess.

## Public surface

- Module-private helpers (no `pub` items at the top level).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
