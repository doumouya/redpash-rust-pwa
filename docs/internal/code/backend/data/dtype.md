---
title: backend/crates/data/src/dtype.rs
source: ../../../../../backend/crates/data/src/dtype.rs
owner: Gus
section: Internal · Code · backend · data
last modified date: 2026-05-30
---

# dtype.rs

## Purpose

Per-column type inference + light stats.

Polars already infers a *storage* type when it parses the CSV — this
module coerces that into the frontend vocabulary (`int`, `float`,
`bool`, `date`, `string`, `empty`) **and** runs a `semantic_dtype`
sniff: for a column Polars had to store as `string` because its
cells are messy (`€995,83`, `Oui`/`non`, `12/03/2024`), we sample
~50 non-null values and guess the *intended* dtype. The cleanness
scorer then docks columns where storage and semantic disagree,
proportional to how many cells fail a strict native parse.

## Public surface

- `pub fn summarize` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
