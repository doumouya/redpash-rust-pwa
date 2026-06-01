---
title: backend/crates/api/src/main.rs
source: ../../../../../backend/crates/api/src/main.rs
owner: Gus
section: Internal · Code · backend · api
last modified date: 2026-05-30
---

# main.rs

## Purpose

`redpash-api` — HTTP entrypoint.

Boots in three steps:
1. load `.env` (DATABASE_URL, REDPASH_BIND, …) — silent if file missing
2. init `tracing-subscriber` from RUST_LOG (default `info`)
3. build the Axum router from `routes::router()` and serve until SIGTERM

**Kafka loader mode** (CAS_75A0D1FD): when `REDPASH_KAFKA_LOAD` is set, after
the `.env` load the binary runs the one-shot ETL loader
([kafka_loader.rs](kafka_loader.md)) — consume → decode → load into a
project_files row — then exits, INSTEAD of serving HTTP. A `src/bin` can't reach
`codec_avro`/`db`, so the loader rides the main binary as a mode.

## Public surface

- Module-private helpers (no `pub` items at the top level).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
