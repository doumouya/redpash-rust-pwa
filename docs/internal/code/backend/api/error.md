---
title: backend/crates/api/src/error.rs
source: ../../../../../backend/crates/api/src/error.rs
owner: Gus
section: Internal · Code · backend · api
last modified date: 2026-05-30
---

# error.rs

## Purpose

HTTP-friendly error type — the airlock between rich server-side
diagnostics and a sanitized wire response.

`AppError` carries an optional [`eyre::Report`] (`inner`) that
preserves the full source chain + lazy backtrace from the
originating error (sqlx PgError, polars, IO, etc). The report is
**server-side only**: `IntoResponse` logs it through tracing
(Channel A — pretty-printed chain + Debug backtrace) and stuffs an
[`EventInfo`] extension on the response for `capture_mw` to persist
to the events table (Channel B). The wire response carries ONLY
`kind` + `message` — `inner` is dropped before any bytes leave the
process.

## Public surface

- `pub struct AppError` — struct

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
