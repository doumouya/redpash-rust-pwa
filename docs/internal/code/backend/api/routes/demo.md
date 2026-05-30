---
title: backend/crates/api/src/routes/demo.rs
source: ../../../../../../backend/crates/api/src/routes/demo.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-30
---

# demo.rs

## Purpose

`/api/demo` — the public landing-page "parse any CSV" demo.

`POST /api/demo/parse` takes a raw CSV body, parses + cleanness-
scores it entirely in memory, and returns the score. **No auth,
nothing stored, no file row** — it exists to show a visitor what
RedPash sees in their messiest file, then funnel them to sign-up.

## Public surface

- `pub fn routes` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
