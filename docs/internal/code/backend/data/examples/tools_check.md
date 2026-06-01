---
title: backend/crates/data/examples/tools_check.rs
source: ../../../../../../backend/crates/data/examples/tools_check.rs
owner: Torv
section: Internal · Code · backend · data · examples
last modified date: 2026-06-01
---

# tools_check.rs

## Purpose

Tools-palette verification — runs EVERY Tools-panel operation against
one real file and prints before→after, answering "do all the buttons
work?" with data instead of clicking. Each tool is applied to a fresh
parse of the file (independent, no cascade) through the exact
`steps::apply(kind, params)` the api crate calls.

cargo run --example tools_check -- <file.csv>

A tool that errors or returns an obviously-wrong shape prints FAIL;
`unwrap_csv` correctly refusing a multi-column frame is reported as
expected, not a failure.

## Public surface

- Module-private helpers (no `pub` items at the top level). Entry: `main`.

## Drift-prone areas

- The case list references columns by position (tuned for
  `raw_001_clients_fr`); a different file shape needs different indices.
- Keep the kinds in step with the `steps::apply` dispatch +
  `frontend/scripts/tools/catalog.js`.

## Related

- [Backend pillar landing](../../index.md)
- `clean_dir.md` — the efficacy/score sibling.
