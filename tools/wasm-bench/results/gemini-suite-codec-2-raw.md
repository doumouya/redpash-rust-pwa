# Gemini adversarial Avro suite #2 — actual vs predicted
Run: 2026-06-01T02:32:24Z
Endpoint: http://localhost:8088/api/demo/avro-decode

## Case smoke: endpoint reachable (int(1) raw)
- **predicted**: 200 decoded=1 (sanity check that endpoint is live)
- **wire**: raw
- **http**: 200
- **body**: `{"decoded":1,"decode_ms":0,"byte_count":1}`

## Case 1: logical date — int + logicalType:date
- **predicted**: 🐛 Debug-stringified 'Date(18)' instead of clean int/string (codec_avro.rs:82)
- **wire**: raw
- **http**: 200
- **body**: `{"decoded":"1970-01-19","decode_ms":0,"byte_count":1}`

## Case 2: logical uuid — string + logicalType:uuid
- **predicted**: 🐛 Debug-stringified 'Uuid(...)' instead of clean UUID string
- **wire**: raw
- **http**: 200
- **body**: `{"decoded":"123e4567-e89b-12d3-a456-426614174000","decode_ms":0,"byte_count":37}`

## Case 3: union index out of range (3 in 3-variant union)
- **predicted**: 422 decode_failed with clean out-of-bounds error
- **wire**: raw
- **http**: 422
- **body**: `{"error":"avro decode failed: Union index 3 out of bounds: 3","kind":"decode_failed"}`

## Case 4: deeply nested union (spec violation)
- **predicted**: 400 invalid schema (Avro spec forbids nested unions)
- **wire**: raw
- **http**: 400
- **body**: `{"error":"invalid avro schema: Unions may not directly contain a union","kind":"schema"}`

## Case 5: empty bytes against record schema
- **predicted**: 422 unexpected EOF
- **wire**: raw
- **http**: 422
- **body**: `{"error":"avro decode failed: Failed to read bytes for decoding variable length integer: failed to fill whole buffer","kind":"decode_failed"}`

## Case 6: int(1) + trailing garbage bytes
- **predicted**: 200 decoded=1 (trailing bytes ignored OR strictness warning)
- **wire**: raw
- **http**: 422
- **body**: `{"error":"trailing 3 byte(s) after the avro datum (wrong wire_format or schema?)","kind":"decode_failed"}`

## Case 7: invalid UTF-8 byte 0xFF in string content
- **predicted**: 422 invalid UTF-8 error (must NOT panic)
- **wire**: raw
- **http**: 422
- **body**: `{"error":"avro decode failed: Invalid utf-8 string","kind":"decode_failed"}`

## Case 8: raw payload with confluent wire_format flag
- **predicted**: 422 invalid magic byte (0x02, expected 0x00)
- **wire**: confluent
- **http**: 422
- **body**: `{"error":"not a Confluent-framed avro payload (expected magic 0x00 + 4-byte schema id)","kind":"decode_failed"}`

## Case 9: enum symbol index 3 in 3-symbol enum
- **predicted**: 422 out-of-bounds enum index
- **wire**: raw
- **http**: 422
- **body**: `{"error":"avro decode failed: Enum value index 3 is out of bounds 3","kind":"decode_failed"}`

## Case 10: map with duplicate keys (last-write-wins or panic?)
- **predicted**: 200 {"a":2} (HashMap overwrites; spec doesn't forbid)
- **wire**: raw
- **http**: 200
- **body**: `{"decoded":{"a":2},"decode_ms":0,"byte_count":8}`

## Case 11: large array block size header (OOM attack)
- **predicted**: 422 unexpected EOF (must NOT pre-allocate based on header)
- **wire**: raw
- **http**: 422
- **body**: `{"error":"avro decode failed: Unable to allocate 2147483647 bytes (maximum allowed: 536870912)","kind":"decode_failed"}`

## Case 12: double NaN (IEEE 754) — serde_json refuses to serialize NaN
- **predicted**: 🐛 likely 500 if serde_json panics on NaN OR 200 with null/string fallback
- **wire**: raw
- **http**: 200
- **body**: `{"decoded":null,"decode_ms":0,"byte_count":8}`

## Case 13: self-referencing recursive record (stack overflow attack)
- **predicted**: 🚨 500 stack overflow OR clean 422 (depth limit) OR 413 (>4MiB)
- **wire**: raw
tools/wasm-bench/run-gemini-codec-2.sh: line 121: /usr/bin/jq: Argument list too long
- **http**: 400
- **body**: `Failed to parse the request body as JSON: EOF while parsing a value at line 1 column 0`

## Case 14: fixed size 6, only 5 bytes provided
- **predicted**: 422 unexpected EOF
- **wire**: raw
- **http**: 422
- **body**: `{"error":"avro decode failed: Failed to read fixed number of bytes '6': : failed to fill whole buffer","kind":"decode_failed"}`

## Case 15: logical decimal — bytes + logicalType:decimal
- **predicted**: 🐛 Debug-stringified 'Decimal(...)' instead of clean number/string
- **wire**: raw
- **http**: 200
- **body**: `{"decoded":"Decimal(Decimal { value: 1234, len: 2 })","decode_ms":0,"byte_count":3}`

## Case 16: empty string (zero-length prefix)
- **predicted**: 200 decoded="" (boundary test)
- **wire**: raw
- **http**: 200
- **body**: `{"decoded":"","decode_ms":0,"byte_count":1}`

## Case 17: string with NUL byte in middle (hel\x00lo)
- **predicted**: 200 decoded="hello" (NUL preserved; tests no C-string truncation)
- **wire**: raw
- **http**: 422
- **body**: `{"error":"trailing 1 byte(s) after the avro datum (wrong wire_format or schema?)","kind":"decode_failed"}`

## Case 18: record without name field (schema validation)
- **predicted**: 400 schema validation error (record requires name)
- **wire**: raw
- **http**: 400
- **body**: `{"error":"invalid avro schema: No `name` field","kind":"schema"}`

## Case 19: missing field bytes (record needs a + b, only a provided)
- **predicted**: 422 unexpected EOF on field b
- **wire**: raw
- **http**: 422
- **body**: `{"error":"avro decode failed: Failed to read bytes for decoding variable length integer: failed to fill whole buffer","kind":"decode_failed"}`

## Case 20: missing field with null default (defaults ≠ padding)
- **predicted**: 422 unexpected EOF (default is for schema evolution, not byte padding)
- **wire**: raw
- **http**: 200
- **body**: `{"decoded":{"a":1,"b":null},"decode_ms":0,"byte_count":1}`

──
## Endpoint contract reminder
──
/api/demo/avro-decode shipped by BE in commit f183152.
If all cases return 405, the binary serving $URL doesn't have the route yet.
If smoke returns 200 with decoded=1, the runner is ready.
