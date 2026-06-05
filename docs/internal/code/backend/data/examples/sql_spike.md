---
title: backend/crates/data/examples/sql_spike.rs
source: ../../../../../../backend/crates/data/examples/sql_spike.rs
owner: Torv
section: Internal · Code · backend · data · examples
last modified date: 2026-06-05
---

# sql_spike.rs

## Purpose

Coverage-regression harness for Polars SQL. Registers two sample frames in a
`SQLContext`, runs ~30 named probes across the analytical query surface, and
prints a PASS/FAIL matrix. Born as the Phase-0 de-risking spike for the
SQL-complete redtable; kept because re-running it after a Polars upgrade
instantly shows which previously-unsupported constructs (window ranking, set
operations, ROLLUP, …) have started working.

## Public surface

- `fn main` — runnable example only (`cargo +stable run -p data --example sql_spike`); no library API.

## Drift-prone areas

- The probe list encodes the *target* surface; the recorded results + the rewrite paths for the gaps live in [phase-0 coverage](../../../../specs/sql-redtable/phase-0-coverage.md). Keep the two in sync if probes are added.
- Requires the `sql` feature on the native polars dep (`backend/Cargo.toml`); builds on stable (see the [toolchain pin](../../../../../../rust-toolchain.toml)).

## Related

- [data::sql substrate](../sql.md)
- [SQL-redtable Phase-0 coverage](../../../../specs/sql-redtable/phase-0-coverage.md)
