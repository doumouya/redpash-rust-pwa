---
title: backend/crates/api/src/routes/demo.rs
source: ../../../../../../backend/crates/api/src/routes/demo.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-30
---

# demo.rs

## Purpose

`/api/demo/*` — public, **no-auth, nothing-stored** demo endpoints (4 MiB router
body cap → 413 over-limit):

- `POST /api/demo/parse` takes a raw CSV body, parses + cleanness-scores it in
  memory, returns the score — shows a visitor what RedPash sees in their messiest
  file, then funnels to sign-up.
- `POST /api/demo/avro-decode` — the adversarial-testing sibling for the codec
  registry's Avro meta-codec (CAS_75A0D1FD, Gemini Suite #2). Decodes an Avro
  payload against a supplied schema in memory, returns the decoded JSON — fires
  schemas+payloads straight at [codec_avro](../codec_avro.md), no Kafka needed.

## Public surface

- `pub fn routes` — the `/parse` + `/avro-decode` router with the 4 MiB cap.
- `POST /parse` — body = raw CSV bytes; 200 → `{rows, columns, score,
  type_mismatches, empty_pct, parse_ms}`; 400 on empty.
- `POST /avro-decode` — body = JSON `{schema, wire_format, bytes_base64}`; 200 →
  `{decoded, decode_ms, byte_count}`. **400** = bad `wire_format`
  (not `raw`/`confluent`) / invalid base64 / unparseable Avro schema
  (`codec_avro::validate_schema`); **422** = schema parses but bytes don't decode
  against it (`decode_failed`, a domain error not a 500); **413** = over 4 MiB.

## Drift-prone areas

- **No auth, in-memory, nothing stored** — both endpoints; don't add a DB write
  or file row here (that's the authenticated upload path). Keep the body cap small.
- **400 vs 422 on avro-decode is deliberate**: a bad *schema* (client error, 400)
  vs a schema/bytes *mismatch* (decode domain, 422). `validate_schema` runs first
  (400), then `codec_avro::decode_guarded` (422 on mismatch / trailing bytes /
  recursion-bomb guard / over-cap). Decode runs via `spawn_blocking` (it blocks on
  its own decode thread) — keep it off the async runtime. **Never call
  `codec_avro::decode` here directly**: `decode_guarded` is the crash-safe boundary
  (a recursive-schema payload would otherwise stack-overflow + abort the process —
  Gemini Suite #2 Case 17).
- The avro-decode path is the SAME `codec_avro::decode` the Kafka loader uses
  ([kafka_loader.md](../kafka_loader.md)) — adversarial fixes harden the live ETL.
- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.

## Related

- [Backend pillar landing](../../index.md)
