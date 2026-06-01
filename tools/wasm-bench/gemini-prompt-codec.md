# Gemini prompt — adversarial Avro decode for the v1.1 codec registry

Paste this block into a Gemini chat. It describes the **codec registry's Avro meta-codec** surface + the categories of adversarial inputs worth covering. Gemini returns adversarial schemas + payloads + curl commands.

This is Suite #2 of the [[gemini-adversary]] loop — successor to Suite #1 against `/api/demo/parse`. Different engine (apache-avro 0.21 Rust crate, not Polars CSV), different failure modes (logical-type stringification, union variant ambiguity, recursive records, etc.).

---

## The system

We're hardening a Rust Avro decoder used by RedPash's codec registry (CAS_75A0D1FD). The relevant code:

- `backend/crates/api/src/codec_avro.rs` — the decoder. Public function: `decode(bytes: &[u8], schema_json: &str, wire: WireFormat) -> Result<serde_json::Value, CodecError>`
- `WireFormat { Confluent, Raw }` — Confluent strips `{0x00, 4-byte BE schema_id}` prefix; Raw is bare Avro binary.
- Backed by the `apache-avro` 0.21 crate via `from_avro_datum`.

There is currently no end-user-facing endpoint exposing this. **Two ways to drive adversarial inputs:**

### Path A — Build a test endpoint (preferred, faster iteration)

Suggest BE ship `/api/demo/avro-decode` as a sibling to `/api/demo/parse`:

```
POST http://localhost:8088/api/demo/avro-decode
Body: JSON {
  "schema":       "<avro schema as JSON string>",
  "wire_format":  "raw" | "confluent",
  "bytes_base64": "<base64-encoded message bytes>"
}
Body cap: 4 MiB
No auth
```

Response on success (200):
```json
{
  "decoded":    <the decoded value as JSON>,
  "decode_ms":  <integer>,
  "byte_count": <integer>
}
```

Errors:
- 400 — malformed JSON body, missing fields, invalid base64, invalid schema JSON, invalid wire_format
- 422 — decode failed (schema/bytes mismatch); body explains why
- 413 — over 4 MiB

### Path B — Use the existing Kafka path

If endpoint A isn't ready, Em can publish your adversarial payloads to a new topic (e.g. `topic_adversarial_avro`), and we consume via `connectors/kafka-confluent-rc/spike.mjs phase5 topic_adversarial_avro`. Slower iteration but exercises the same codec.

## Your task

Generate **20 adversarial Avro test cases**. For each:

1. The **schema** (Avro JSON).
2. The **bytes** (binary or base64-encoded), constructed to either match or deliberately mismatch the schema.
3. The **wire format** (`raw` or `confluent`).
4. **Expected** decode output OR expected error class.
5. **One-line description** of the edge case being tested.
6. **curl command** (for Path A) OR **kafkajs producer snippet** (for Path B).

## Categories to cover

| Category | Examples worth probing |
|----------|------------------------|
| **Avro logical types** | `timestamp-millis` (the known divergence — Node returns long-as-number, Rust returns Debug-stringified `TimestampMillis(...)`), `date`, `time-millis`, `timestamp-micros`, `decimal`, `uuid`, `duration` |
| **Union variants** | `["null", "string"]` with null value, with string value; `["int","string"]` ambiguous boundary; deeply nested unions `[null, [int, string]]`; unions of records |
| **Enum edge cases** | Symbol index out of range (encoded), empty symbols list in schema, single-symbol enum, symbol with special chars |
| **Recursive records** | Tree-shaped (record references itself), mutual recursion (record A → B → A), infinite-depth (test stack-overflow protection) |
| **Default values** | Field declared with `default: null` but bytes provide a value; field declared with no default + bytes missing it |
| **Truncated payloads** | Bytes shorter than schema expects (3 bytes for an 8-byte long), bytes longer than schema expects (extra bytes after record end) |
| **Wire-format mismatches** | Send `wire_format: "raw"` with Confluent-prefixed bytes (magic byte 0x00); send `wire_format: "confluent"` with raw bytes; correct magic byte but wrong schema_id |
| **Schema malformations** | Invalid JSON (missing closing brace), valid JSON but invalid Avro schema (`type: "not_a_real_type"`), schema with self-referencing record but no name |
| **Float / numeric edges** | `NaN`, `+Inf`, `-Inf` for `double`; `i64::MAX` / `i64::MIN` for `long`; subnormals; negative zero |
| **String edge cases** | Empty string, single byte string, 4 MiB string (cap test), invalid UTF-8 in string field (`\xe9`), null bytes mid-string, RTL/emoji/ZWJ |
| **Bytes/Fixed** | `bytes` field with binary content, `fixed` of size N with bytes of size N±1, base64 round-trip oddities |
| **Map / Array** | Empty map, empty array, deeply nested array of arrays, map with duplicate keys (avro spec is silent — does decoder dedup or keep last?) |

## Output format

For each case, produce a block like:

````
### Case N: <one-line description>

**Schema:**
```json
{<avro schema>}
```

**Bytes (hex):** `0x<bytes>`
**Wire format:** `raw` | `confluent`
**Expected:** decoded as `<value>` OR error class `<400|422>`: `<message hint>`

```sh
# Path A: POST to /api/demo/avro-decode
SCHEMA='{<avro schema as one line>}'
BYTES_B64=$(printf '<bytes>' | base64 -w0)
curl -sX POST http://localhost:8088/api/demo/avro-decode \
  -H 'Content-Type: application/json' \
  -d "{\"schema\":${SCHEMA@Q},\"wire_format\":\"raw\",\"bytes_base64\":\"${BYTES_B64}\"}"
```
````

## Notes for your generation

- **The codec is Rust + apache-avro 0.21**, not Python or Java. The library's `Value::TimestampMillis(DateTime<Utc>)` variant is the known gap from Suite #0 (Kafka topic) — your Suite #2 should exploit this and find similar gaps for other logical types.
- **We want decode failures we can fix**, not crashes. A test that returns 422 with a clear error class is a useful finding. A test that returns 500 / panics is a CRITICAL finding.
- **Don't bother with "valid Avro" cases** — the codec already decodes the JLR Account + AccountTransaction schemas cleanly. Focus on the boundaries.
- **Watch for silent fixes**: schema says `["null","string"]` and bytes encode a union variant tag of 2 (invalid — only 0 and 1 are valid). Does the decoder reject, silently coerce to null, or panic?

## Constraints

- Body cap: 4 MiB (same as Suite #1)
- All bytes must be valid base64 in the request
- Schema must be valid JSON (the API rejects invalid JSON with 400 before reaching the decoder)
- `wire_format` is enum: `"raw"` or `"confluent"`, lowercase, exact spelling

## Once you generate

Em (or BE if Path A endpoint exists) pipes each test into the endpoint and compares actual vs predicted. Same loop as Suite #1: divergences become a case for BE to harden the codec.

The known starting point: **logical types fall back to Debug-stringified output** in `codec_avro.rs:82` per the catchall `other => Value::String(format!("{other:?}"))`. Cases targeting `timestamp-millis` / `date` / `decimal` / `uuid` will likely all expose the same shape and need the same fix family (extend explicit match arms).
