---
title: backend/crates/api/src/codec_avro.rs
source: ../../../../../backend/crates/api/src/codec_avro.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-06-01
---

# codec_avro.rs

## Purpose

The **avro meta-codec decode engine** — Rust-central Avro decode for the
[codec registry](codec_registry.md) (CAS_75A0D1FD). Decodes a wire payload to
`serde_json::Value` given the writer schema. The **first ETL connector**
(`connectors/kafka-confluent-rc`, JLR Account stream) decodes through here.

Two foundational decisions baked in:

- **Rust-central decode** (Em 2026-06-01): the backend codec decodes; connectors
  are thin transport (consume Kafka → hand bytes + schema to the backend). Honors
  the locked [js-rust-boundary](../../../architecture/js-rust-boundary.md) (Rust
  owns the data engine), gives one decode home for every format, and is
  offline-capable. The spike's Node decode was exploratory.
- **Schema from the contract file, not a runtime registry** (data-contract-first,
  [[data-format-open-ended]]): the caller resolves the Avro schema from the
  connector's saved `contracts/*.json` (`.schema` field of the Confluent
  envelope). Runtime Schema-Registry resolution + caching earns its complexity
  only at scale (CAS_ACAA76AA spike); the file beats it on cold-start/auth/retry
  for a connector we own end-to-end.

## Public surface

- `pub enum WireFormat { Raw, Confluent }` + `from_meta(Option<&str>)` —
  `codec_meta.wire_format`, defaults `Confluent`. The spike's 7th design call:
  Em's JLR producer emits **Raw** (bare Avro, no Confluent `{0x00, schema_id}`
  header); defaulting to Confluent would silently corrupt the first field.
- `pub fn validate_schema(schema_json) -> Result<(), String>` — parses the Avro
  schema only; lets a caller split a bad SCHEMA (→ 400) from a schema/bytes
  mismatch at decode (→ 422). Used by `/api/demo/avro-decode`.
- `pub fn decode(bytes, avro_schema_json, wire) -> Result<Value, String>` —
  parses the schema, strips the 5-byte Confluent header when `Confluent`, decodes
  one datum via `apache_avro::from_avro_datum`, converts to JSON. Errors are
  strings (caller maps to 4xx + an audited event).

Registered in [codec_registry](codec_registry.md) as `id="avro", is_meta=true`;
the registry's `validate` runs POST-decode (a decoded record is a JSON object).

## Drift-prone areas

- **`avro_to_json` union-unwrap**: unions read as their inner branch, so
  `[null,string]` decodes to the string or `null`. Logical/temporal Avro types
  (Date, Decimal, Timestamp*, Uuid, …) fall back to a string rendering rather
  than panicking — extend the match when a connector's schema actually surfaces
  one (don't speculate ahead of a real schema).
- **Bytes/Fixed → lossy UTF-8 string**: fine for the current text-heavy Account
  schema; a binary-blob field would want base64 — add it when one appears.
- **Schema source is the caller's**: `decode` takes the schema JSON as a param.
  Resolving it (contract file vs `codec_meta.inline_schema` vs future registry
  fetch) is the ingestion path's job — keep that plumbing out of the decoder.
- **apache-avro dep**: the first non-CSV binary-format decoder in the backend.
  Added per the Rust-central decision; lives in `api` alongside the registry for
  now (a future move to `data` is a pure relocation).
- The round-trip test embeds the REAL v2 contract via `include_str!` — if the
  contract path moves, fix the relative path.

## Related

- [codec_registry.rs](codec_registry.md) — registers `avro` (is_meta); `validate_format` delegates.
- [connectors/kafka-confluent-rc](../../../../connectors/kafka-confluent-rc/) — the Kafka connector + the saved `contracts/`.
- [type-definition spec](../../specs/type-definition.md) §4.2 / CAS_75A0D1FD / CAS_ACAA76AA (the meta-codec spike).
- [js-rust-boundary](../../../architecture/js-rust-boundary.md) — the principle behind Rust-central decode.
