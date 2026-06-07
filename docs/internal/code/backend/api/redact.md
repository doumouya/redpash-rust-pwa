---
title: backend/crates/api/src/redact.rs
source: ../../../../../backend/crates/api/src/redact.rs
owner: Gus
section: Internal · Code · backend · api
last modified date: 2026-06-07
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
values replaced with `[REDACTED]`. `SENSITIVE_KEYS` currently
masks the connector SASL credentials (`sasl_secret_enc`,
`sasl_secret` — see [secrets.rs](secrets.md)); it grows as
more auth-bearing surfaces land. Each addition lands with a
test against a sample chain string. Note the masker's value
terminates at `, } ) ] \n " '` (a chain-string domain), so a
quote-wrapped JSON value isn't matched — the realistic vector
is an error-chain string, and the connector secret never
reaches `events.context` directly (the create event carries
only `{connector, project}`), so this is defense-in-depth.

## Public surface

- `pub const MAX_CHARS` — constant
- `pub fn redact_chain` — function
- `pub fn backtrace_head` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../index.md)
