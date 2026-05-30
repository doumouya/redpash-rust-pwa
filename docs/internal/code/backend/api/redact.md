---
title: backend/crates/api/src/redact.rs
source: ../../../../../backend/crates/api/src/redact.rs
owner: Gus
section: Internal · Code · backend · api
last modified date: 2026-05-30
---

# redact.rs

## Purpose

Redaction discipline for events.context — the single point where
potentially-sensitive payloads from Channel A (rich tracing log
stream) get sanitized before mirroring into Channel B (events
table) for the Monitoring page consumer.

Two rules, evolving:
1. Length cap. The events table is a queryable index, not a
blob store. Capping every redacted string at `MAX_CHARS`
keeps the Monitoring drill-down responsive and the table
from bloating with multi-KB JSON payloads.
2. Substring masking. Known-sensitive field names get their
values replaced with `[REDACTED]`. The list is empty today
(pre-RBAC; no password / token columns exist yet) and
grows as we add auth-bearing surfaces. Each addition lands
with a test against a sample chain string.

## Public surface

- `pub const MAX_CHARS` — constant
- `pub fn redact_chain` — function
- `pub fn backtrace_head` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
