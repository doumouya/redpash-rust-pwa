---
title: backend/crates/api/src/codec_registry.rs
source: ../../../../../backend/crates/api/src/codec_registry.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-06-01
---

# codec_registry.rs

## Purpose

The **codec registry** — the open-ended replacement for the closed `data_type`
enum (spec [type-definition](../../specs/type-definition.md) §4.2 v1.1,
CAS_75A0D1FD). A `data_type` is an OPAQUE codec id resolved against a registry of
registered `Codec`s, not a hardcoded `match`. The disposability win
([[data-format-open-ended]]): a customer / new connector ships a codec with a
`register()` call and zero edits to any consumer — the same open-registry shape
§5 already gave editors on the FE.

Why now: the [[etl-elt-roadmap]] connectors bring formats we can't enumerate
(Avro from Kafka, DB-specific types, …). The 9 builtin formats stop being a
closed enum and become "the v1 known-codec set, registered at startup"; `decimal`
is the first plugin codec (the banking footgun — `float` corrupts money sums).

`field_validate::validate_format` delegates here, so the swap is behaviorally
identical (the existing validate_format tests pass unchanged) while opening the
mechanism. The wire `data_type` was already an open `String` (abd971f), so
nothing downstream changed.

## Public surface

- `pub struct Codec` — `id` + `validate: fn(&Value, &[&str]) -> Result<(), FieldError>`
  + `is_meta` (true for schema-resolving codecs — avro/protobuf — whose
  parse/serialize surface lands with the avro slice).
- `pub struct CodecRegistry` — an open `codec_id -> Codec` map.
  - `new()` / `with_builtins()` (seeds the 10) / `Default` = with_builtins.
  - `register(codec)` — add a codec (custom object / connector).
  - `get(id)` / `ids()` (sorted, for introspection).
  - `validate(id, value, options)` — null → Ok (clear); unknown id →
    `BadValue("codec_not_registered: …")` (§4.2 gate 5, no silent corruption);
    else the codec's `validate`.
- `pub fn registry() -> &'static CodecRegistry` — the process-wide builtin
  registry (`OnceLock`), what `validate_format` delegates to.

Error type is [`field_validate::FieldError`](field_validate.md) (`BadValue` → 400);
concrete codecs only ever produce `BadValue`. `MissingRef`/404 stays in the
referential layer (`validate_ref`).

## Drift-prone areas

- **Concrete vs meta.** Builtin codecs validate from the id alone (pure, sync,
  no DB). Meta-codecs (`is_meta: true`) decode a wire payload against an external
  schema — their parse/serialize + the avro codec land in the avro slice; keep
  the `is_meta` split honest.
- **`rid` is shape-only here.** `c_rid` checks "is a string"; cross-type
  existence is `validate_ref` (async, DB) — don't fold existence into the codec.
- **String-or-native acceptance.** numeric/bool codecs accept a JSON number/bool
  OR a string (the cell-editor PATCHes strings). Tightening to strict JSON would
  break the editor — don't.
- **`decimal` is validate-only.** It enforces a wire-as-string decimal shape;
  exact arithmetic is the storage layer's job (PG `NUMERIC`), not this codec.
- **No live HTTP consumer yet** — the generic custom-object PATCH endpoint is
  future; `validate_format` is the only caller today. The module-level
  `allow(dead_code)` covers `register`/`ids`/… until that endpoint lands.

## Related

- [field_validate.rs](field_validate.md) — `validate_format` delegates here; `validate_ref` is the referential layer.
- [type-definition spec](../../specs/type-definition.md) §4.2 — the contract; CAS_75A0D1FD the v1.1 design.
- [connectors/kafka-confluent-rc](../../../../connectors/kafka-confluent-rc/) — the avro meta-codec's first consumer (decodes against the saved `contracts/` schema, [[data-format-open-ended]] + data-contract-first).
