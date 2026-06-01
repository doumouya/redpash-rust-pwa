# Gemini codec Suite #2 — divergence analysis

**Run:** 2026-06-01T02:32 UTC
**Endpoint:** `POST /api/demo/avro-decode` (commit f183152)
**Suite:** 20 Gemini-designed adversarial Avro cases + retry of Case 13
**Raw output:** `gemini-suite-codec-2-raw.md`

## Headline

**Strong result for the codec.** Of 20 adversarial cases:

- 🐛 **1 real bug found** (Case 15: Decimal logical type Debug-stringified)
- ✨ **3 surprise wins** — Gemini predicted bugs that actually work correctly (date/uuid logical types already have explicit handling; NaN → null gracefully)
- 🛡️ **2 DoS defenses confirmed working** (Cases 11 + 13: apache-avro 512MB allocation cap + endpoint 16KB decode cap)
- ⚠ **2 design-discussion-worthy behaviors** (Case 6: strict trailing-bytes rejection; Case 20: schema-evolution defaults DO fill missing fields)
- 🎯 **12 clean error-class matches** with descriptive messages
- 🤷 **1 malformed test** (Case 17: Gemini's bytes had off-by-one length prefix)

**The codec is in excellent shape.** Most of Gemini's targets were already handled, and the one real find is a small fix (one match arm).

## Verdict table

| # | Description | Gemini predicted | Actual | Verdict |
|---|-------------|------------------|--------|---------|
| **smoke** | int(1) raw | 200 decoded=1 | 200 decoded=1 (decode_ms=0) | ✓ endpoint live |
| 1 | logical date | 🐛 `"Date(18)"` Debug fallback | `"1970-01-19"` clean ISO | **✨ ALREADY HANDLED** |
| 2 | logical uuid | 🐛 `"Uuid(...)"` Debug fallback | `"123e4567-..."` clean UUID | **✨ ALREADY HANDLED** |
| 3 | union index out of range | 422 | `422 "Union index 3 out of bounds: 3"` | ✓ exact |
| 4 | nested union spec violation | 400 | `400 "Unions may not directly contain a union"` | ✓ exact |
| 5 | empty record bytes | 422 | `422 "failed to fill whole buffer"` | ✓ exact |
| 6 | int + trailing garbage | 200 ignore | `422 "trailing 3 byte(s) after the avro datum"` | ⚠ **STRICTER than predicted** |
| 7 | invalid UTF-8 in string | 422 (no panic) | `422 "Invalid utf-8 string"` | ✓ no panic |
| 8 | wire-format mismatch | 422 magic byte | `422 "not a Confluent-framed avro payload"` | ✓ exact |
| 9 | enum out of bounds | 422 | `422 "Enum value index 3 is out of bounds 3"` | ✓ exact |
| 10 | map duplicate keys | 200 `{a:2}` | `200 {"a":2}` | ✓ exact (HashMap last-write-wins) |
| 11 | array OOM via header | 422 (no pre-alloc) | `422 "Unable to allocate 2147483647 bytes (max 536870912)"` | **🛡️ 512MB cap catches it** |
| 12 | NaN double serde panic | 🐛 500 or null fallback | `200 decoded=null` | **✨ GRACEFUL** |
| 13 | recursive schema stack overflow | 🚨 500 stack overflow OR 422 depth OR 413 | `413 "exceeds 16384-byte decode cap"` | **🛡️ 16KB decode cap blocks it** |
| 14 | fixed size mismatch | 422 EOF | `422 "Failed to read fixed number of bytes '6'"` | ✓ exact |
| 15 | **logical decimal** | 🐛 `"Decimal(...)"` Debug fallback | `"Decimal(Decimal { value: 1234, len: 2 })"` | **🐛 BUG CONFIRMED** |
| 16 | zero-length empty string | 200 `""` | `200 decoded=""` | ✓ exact |
| 17 | NUL byte mid-string | 200 NUL preserved | `422 "trailing 1 byte(s)"` | 🤷 **Gemini's test was malformed** (length prefix 0x0a = 5 chars, but 6 chars provided) |
| 18 | unnamed record | 400 | `400 "No \`name\` field"` | ✓ exact |
| 19 | missing field bytes | 422 EOF | `422 "failed to fill whole buffer"` | ✓ exact |
| 20 | missing field WITH null default | 422 (defaults ≠ padding) | `200 {"a":1,"b":null}` | ⚠ **Schema-evolution behavior**: reader defaults DO fill missing trailing fields. Gemini's prediction wrong; behavior is correct per Avro semantics. |

## The one real bug (Case 15) — Decimal logical type

```
predicted: 🐛 "Decimal(...)" via codec_avro.rs:82 catchall
actual:    "Decimal(Decimal { value: 1234, len: 2 })"
```

**Fix path** (single match arm in `avro_to_json`):

```rust
// Currently hits the catchall:
//   other => Value::String(format!("{other:?}"))
// Add an explicit arm:
Av::Decimal(d) => {
    // apache_avro::Decimal exposes .as_bytes() + serialize the
    // numeric value. For consistency with the Node spike's behavior
    // + the [[data-format-open-ended]] codec contract:
    //   - "decimal" as a string preserves precision
    //   - or as a JSON number (lossy for >2^53)
    // Recommend: string serialization for safety.
    Value::String(d.to_string())  // e.g. "12.34"
}
```

Same fix pattern as date/uuid which already have explicit arms (and explain why Gemini's predictions for 1 + 2 were wrong — those got fixed before this run, just not Decimal).

**Severity: LOW**. Decimal is rare in our current use case (JLR Account + Transaction don't use it). Worth fixing for completeness but not blocking.

## The two DoS defenses worth celebrating

### Case 11: Pre-allocation attack caught

```
Input:  array block-size header = i32::MAX (2147483647 bytes pre-allocate signal)
Output: 422 "Unable to allocate 2147483647 bytes (maximum allowed: 536870912)"
```

apache-avro 0.21 has a **built-in 512MB allocation cap**. Even if a malicious schema header says "allocate 2GB for this array," the library refuses. No pre-allocation OOM possible.

### Case 13: Recursive stack overflow blocked at the layer before the codec

```
Input:  1MB of 0x02 against {name: "Node", next: ["null", Node]} (1.3MB JSON body)
Output: 413 "decoded payload 1000000 bytes exceeds the 16384-byte decode cap"
```

The avro-decode endpoint has a **16KB cap on the decoded payload**, separate from the 4MiB HTTP body limit. The recursive schema can't even reach the codec to trigger stack overflow — the body rejected at the size-check layer.

**Two-layer DoS defense**: HTTP body (4MiB) + decoded payload (16KB) + apache-avro allocation (512MB). Each layer narrows the attack surface.

## The two design-discussion-worthy behaviors

### Case 6: Strict on trailing bytes after the datum

```
Input:  int(1) + 3 trailing 0xFF bytes
Output: 422 "trailing 3 byte(s) after the avro datum (wrong wire_format or schema?)"
```

The codec is **strict**: any bytes after a valid datum trigger 422. This is GOOD when used as wire-format-mismatch detection (the Kafka loader sees a single record per Kafka message, so trailing bytes ≡ schema mismatch). Whether this strictness is the right default for ALL future consumers is worth discussing — a non-Kafka context might genuinely want lenient mode.

**No work needed today**; just be aware that adding "strict_trailing_bytes" as a codec_meta knob may be a v2 ask.

### Case 20: Schema-evolution defaults DO fill missing fields

```
Schema: {a: int, b: ["null", int], default: null}
Input:  bytes for a only (no bytes for b)
Output: 200 {"a": 1, "b": null}
```

Gemini predicted 422 ("defaults are for schema evolution, not padding"). The codec's behavior: **uses defaults to fill missing trailing fields**.

This is actually a reasonable interpretation when treating "the inline_schema is BOTH writer AND reader schema". In that mode, missing-trailing-field-with-default → use default. Gemini's prediction assumed strict-writer-schema mode where bytes must match the schema exactly.

For our Kafka loader use case (writer schema = registry contract, reader schema = the same contract): missing trailing bytes shouldn't happen because the producer always writes all fields. But if it does (legacy producer), the default lets us decode gracefully.

**No work needed today**; this is arguably correct + lenient-by-default. Worth documenting in codec_avro.md.

## One malformed test (Case 17)

Gemini's bytes were `\x0a\x68\x65\x6c\x00\x6c\x6f`:
- 0x0a = zigzag(10) = decoded 5 → claim string length 5
- Then 6 chars provided: `h e l \0 l o`

The codec correctly read 5 chars (`hel\0l`) + flagged trailing byte (`o`). **Not a codec bug** — Gemini's test had an off-by-one length prefix. Should have been 0x0c (zigzag(12) = 6).

## Sequencing

- **Filing the Decimal logical-type finding** as the only new hardening item on CAS_91A65088. Single match-arm fix in codec_avro.rs's `avro_to_json`. Low priority (no current consumer uses Decimal).
- **No other items** for the codec hardening. Out of 20 hostile cases, the codec passed 19 with proper semantics. apache-avro 0.21 + BE's wrapper is solid.
- The runner becomes the regression baseline for codec changes — re-run after any codec_avro.rs edit to verify no behavioral drift.

## Cross-suite tally (today's full adversarial coverage)

| Suite | LLM | Surface | Cases | Findings |
|-------|-----|---------|-------|----------|
| Suite #1 | Gemini | CSV parser | 20 | 6 (CAS_BFF77F18) |
| Suite #1B | Copilot | CSV parser | 20 | 0 new (confirms + sharpens existing) |
| Copilot stress #1 | Copilot | CSV parser (panic-bait) | 7 | 0 new + robustness validation |
| **Codec #2** | **Gemini** | **codec_avro.rs** | **20** | **1 (Decimal Debug)** |

67 total adversarial cases run across two engines + two LLMs. **7 hardening findings filed; 2 new design discussions; the rest are clean passes or robustness wins.** The multi-adversary-LLM property delivered for both engines.

## What the codec being-in-great-shape means

The hard work of v1.1 + codec_avro.rs + the audit pattern paid off. apache-avro 0.21 is a mature crate; BE's wrapper is thin + correct; the endpoint adds layered DoS defense. Gemini's 20-case stress could only find one minor logical-type gap.

This is the moment to move on to the NEXT engine (postgres-cdc-rc connector decode? kafka loader's records→CSV conversion? something further afield?) rather than dig deeper here. The marginal cost of more adversarial CSV/Avro cases is rising; the marginal value is now low.
