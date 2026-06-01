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
  one datum via `apache_avro::from_avro_datum`, **errors on trailing bytes**
  (a wrong wire_format/schema otherwise silently truncates), converts to JSON
  with a depth limit (`MAX_JSON_DEPTH`). Errors are strings (caller maps to 4xx).
  **Do not call on untrusted bytes directly — use `decode_guarded`.**
- `pub fn decode_guarded(bytes, schema, wire) -> Result<Value, String>` — the
  crash-safe boundary. A NON-recursive schema decodes directly (depth fixed by
  the schema, size-independent). A RECURSIVE schema (`schema_is_recursive`
  heuristic) is byte-capped (`MAX_RECURSIVE_DECODE_BYTES` = 16 KiB) and run on a
  1 GiB-stack thread, because `from_avro_datum`'s BUILD recurses ~once per input
  byte with a heavy frame — an unbounded recursive payload otherwise
  stack-overflows + **aborts the process** (Gemini Suite #2, Case 17).
- `pub const MAX_RECURSIVE_DECODE_BYTES` — the recursive-schema input cap.

Registered in [codec_registry](codec_registry.md) as `id="avro", is_meta=true`;
the registry's `validate` runs POST-decode (a decoded record is a JSON object).

## Drift-prone areas

- **Recursion-bomb defense has THREE layers** (Suite #2 Case 17 abort): (1)
  `schema_is_recursive` flags self-referential schemas; (2) recursive decodes are
  byte-capped + run on a 1 GiB stack so `from_avro_datum`'s build survives; (3)
  `avro_to_json` is depth-limited (`MAX_JSON_DEPTH`=200) so the OUTPUT value can't
  be deep enough to overflow a normal stack on drop/serialize at the caller. All
  three are needed — the build, the produced value, and the caller each recurse.
  A Rust stack overflow is **not catchable** (it aborts), so this is prevention,
  not recovery.
- **`avro_to_json` logical/temporal types** decode to SEMANTIC JSON: `date`/
  `timestamp*` → ISO strings, `time*` → integer (ms/µs since midnight), `uuid` →
  the string, `bigdecimal` → string. `Decimal` (scale is schema-side, absent at
  the value layer) + `Duration` still render best-effort — revisit if a real
  schema surfaces them.
- **Trailing-byte guard**: `decode` errors if a single datum doesn't consume the
  whole payload — catches a Confluent-framed payload mis-decoded as Raw (reads
  `0x00` as an empty string + ignores the rest). Legit single-datum messages have
  no trailing bytes, so no false errors.
- **`schema_is_recursive` over-approximates** (a non-recursive name reuse also
  flags) — safe: it only triggers the tighter cap, never wrong output.
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
