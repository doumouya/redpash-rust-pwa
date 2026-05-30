---
title: backend/crates/data/src/encoding.rs
source: ../../../../../backend/crates/data/src/encoding.rs
owner: Gus
section: Internal · Code · backend · data
last modified date: 2026-05-30
---

# encoding.rs

## Purpose

Byte-buffer → encoding name.

Uses Mozilla's `chardetng` detector — same algorithm Firefox ships.
Returns the IANA name (`utf-8`, `windows-1252`, `iso-8859-1`,
`utf-16le`, …) so the result feeds directly into `encoding_rs`.

## Public surface

- `pub fn detect` — function
- `pub fn decode` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
