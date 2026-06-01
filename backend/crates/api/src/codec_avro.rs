//! Purpose: the **avro meta-codec** decode engine — Rust-central Avro decode for
//! the codec registry (CAS_75A0D1FD, Em 2026-06-01 chose Rust-central per the
//! js-rust-boundary; connectors are thin transport). Decodes a wire payload to
//! `serde_json::Value` given the writer schema, which the caller resolves from
//! the connector's saved `contracts/` file (data-contract-first, [[data-format-open-ended]])
//! — NOT a runtime Schema Registry fetch (that earns complexity only at scale).
//! Doc: docs/internal/code/backend/api/codec_avro.md
//!
//! Two wire formats (the spike's 7th design call, CAS_ACAA76AA): `Confluent`
//! frames the datum as `{0x00, 4-byte BE schema_id, avro}`; `Raw` is bare Avro
//! binary with the schema known out-of-band — which is what Em's JLR producer
//! emits. Defaulting to Confluent would silent-fail on Raw, so the codec branches.
//!
//! Registered in [codec_registry] as `id="avro", is_meta=true`. The registry's
//! `validate` checks a DECODED record (object); this module is the decode.
#![allow(dead_code)]

use serde_json::{Number, Value};

/// Avro wire framing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireFormat {
    /// Bare Avro binary; schema known out-of-band (Em's JLR producer).
    Raw,
    /// Confluent `{magic 0x00, 4-byte BE schema_id, avro}`.
    Confluent,
}

impl WireFormat {
    /// Parse `codec_meta.wire_format`; defaults to `Confluent` (the ecosystem
    /// default) when unset, per the spike's design-call answer.
    pub fn from_meta(s: Option<&str>) -> Self {
        match s {
            Some("raw") => WireFormat::Raw,
            _ => WireFormat::Confluent,
        }
    }
}

/// Validate that `schema_json` parses as an Avro schema. Lets a caller
/// distinguish a bad SCHEMA (→ 400) from a schema/bytes mismatch at decode
/// (→ 422) — e.g. the `/api/demo/avro-decode` adversarial surface.
pub fn validate_schema(schema_json: &str) -> Result<(), String> {
    apache_avro::Schema::parse_str(schema_json)
        .map(|_| ())
        .map_err(|e| format!("invalid avro schema: {e}"))
}

/// Decode an Avro datum to JSON given the writer schema JSON (the Avro schema,
/// e.g. extracted from the Confluent contract envelope's `.schema` field).
/// `Confluent` strips the 5-byte header first. Errors are strings (the caller
/// maps to a 4xx + an audited event).
pub fn decode(bytes: &[u8], avro_schema_json: &str, wire: WireFormat) -> Result<Value, String> {
    let schema = apache_avro::Schema::parse_str(avro_schema_json)
        .map_err(|e| format!("invalid avro schema: {e}"))?;

    let payload: &[u8] = match wire {
        WireFormat::Raw => bytes,
        WireFormat::Confluent => {
            if bytes.len() < 5 || bytes[0] != 0x00 {
                return Err("not a Confluent-framed avro payload (expected magic 0x00 + 4-byte schema id)".into());
            }
            &bytes[5..]
        }
    };

    let mut cursor = std::io::Cursor::new(payload);
    let avro = apache_avro::from_avro_datum(&schema, &mut cursor, None)
        .map_err(|e| format!("avro decode failed: {e}"))?;

    // Trailing-byte guard: a single datum should consume the whole payload. Left-
    // over bytes mean the wire_format or schema is wrong (e.g. a Confluent-framed
    // payload decoded as Raw reads `0x00` as an empty string + ignores the rest).
    // Surface it loudly rather than silently returning a truncated/wrong value.
    let consumed = cursor.position() as usize;
    if consumed < payload.len() {
        return Err(format!(
            "trailing {} byte(s) after the avro datum (wrong wire_format or schema?)",
            payload.len() - consumed
        ));
    }
    // Convert with a depth limit. `avro` may be pathologically deep (recursive
    // schema); converting it here — on `decode_guarded`'s big-stack thread —
    // means the deep `apache_avro::Value` is consumed + dropped on the big
    // stack, and only a SHALLOW result (or a depth error) crosses back to the
    // caller. Without the limit, a deep `serde_json::Value` overflows the
    // caller's normal stack on drop/serialize (Case 17).
    avro_to_json(avro, 0)
}

/// Max value-nesting depth we'll materialize as JSON. Real records are shallow
/// (a few levels); anything past this is a recursion bomb. Keeps the produced
/// `serde_json::Value` safe to drop + serialize on a normal stack.
const MAX_JSON_DEPTH: usize = 200;

/// Convert an `apache_avro::types::Value` to `serde_json::Value`. Unions unwrap
/// to their inner branch (so `[null,string]` reads as the string or null);
/// **logical/temporal types decode to semantic JSON** (ISO dates/timestamps,
/// the uuid string, time as an int) rather than a `Debug` rendering.
fn avro_to_json(v: apache_avro::types::Value, depth: usize) -> Result<Value, String> {
    use apache_avro::types::Value as Av;
    if depth > MAX_JSON_DEPTH {
        return Err(format!("avro value nesting exceeds {MAX_JSON_DEPTH} levels (recursion bomb?)"));
    }
    Ok(match v {
        Av::Null => Value::Null,
        Av::Boolean(b) => Value::Bool(b),
        Av::Int(i) => Value::from(i),
        Av::Long(i) => Value::from(i),
        Av::Float(f) => num(f as f64),
        Av::Double(f) => num(f),
        Av::String(s) | Av::Enum(_, s) => Value::String(s),
        Av::Bytes(b) | Av::Fixed(_, b) => Value::String(String::from_utf8_lossy(&b).into_owned()),
        Av::Union(_, inner) => avro_to_json(*inner, depth + 1)?,
        Av::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for it in items {
                out.push(avro_to_json(it, depth + 1)?);
            }
            Value::Array(out)
        }
        Av::Map(m) => {
            let mut o = serde_json::Map::new();
            for (k, vv) in m {
                o.insert(k, avro_to_json(vv, depth + 1)?);
            }
            Value::Object(o)
        }
        Av::Record(fields) => {
            let mut o = serde_json::Map::new();
            for (k, vv) in fields {
                o.insert(k, avro_to_json(vv, depth + 1)?);
            }
            Value::Object(o)
        }
        // ── logical / temporal types → semantic JSON (not Debug strings) ──
        Av::Date(days) => chrono::DateTime::from_timestamp(days as i64 * 86_400, 0)
            .map(|dt| Value::String(dt.format("%Y-%m-%d").to_string()))
            .unwrap_or_else(|| Value::from(days)),
        // time-of-day: emit the raw count (ms/µs since midnight) — unambiguous + lossless.
        Av::TimeMillis(ms) => Value::from(ms),
        Av::TimeMicros(us) => Value::from(us),
        Av::TimestampMillis(ms) => chrono::DateTime::from_timestamp_millis(ms)
            .map(|dt| Value::String(dt.to_rfc3339()))
            .unwrap_or_else(|| Value::from(ms)),
        Av::TimestampMicros(us) => chrono::DateTime::from_timestamp_micros(us)
            .map(|dt| Value::String(dt.to_rfc3339()))
            .unwrap_or_else(|| Value::from(us)),
        Av::TimestampNanos(ns) => {
            chrono::DateTime::from_timestamp(ns.div_euclid(1_000_000_000), ns.rem_euclid(1_000_000_000) as u32)
                .map(|dt| Value::String(dt.to_rfc3339()))
                .unwrap_or_else(|| Value::from(ns))
        }
        Av::LocalTimestampMillis(ms) => chrono::DateTime::from_timestamp_millis(ms)
            .map(|dt| Value::String(dt.naive_utc().to_string()))
            .unwrap_or_else(|| Value::from(ms)),
        Av::LocalTimestampMicros(us) => chrono::DateTime::from_timestamp_micros(us)
            .map(|dt| Value::String(dt.naive_utc().to_string()))
            .unwrap_or_else(|| Value::from(us)),
        Av::LocalTimestampNanos(ns) => Value::from(ns),
        Av::Uuid(u) => Value::String(u.to_string()),
        Av::BigDecimal(d) => Value::String(d.to_string()),
        // Decimal carries no scale at the value layer (scale is schema-side) +
        // Duration is a {months,days,millis} triple — render best-effort. Rare;
        // revisit if a connector's schema actually surfaces them.
        other @ (Av::Decimal(_) | Av::Duration(_)) => Value::String(format!("{other:?}")),
    })
}

fn num(f: f64) -> Value {
    Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
}

/// Input cap for decoding against a RECURSIVE schema. `apache-avro`'s
/// `from_avro_datum` BUILD recurses ~once per input byte with no depth limit and
/// a heavy (~tens-of-KiB) stack frame per level, so a self-referential schema +
/// deep bytes stack-overflows + **aborts the process** (a Rust stack overflow is
/// not catchable). Capping the bytes bounds the build depth; paired with the big
/// decode-thread stack below, the worst case stays within the stack. Only
/// recursive schemas need this — a non-recursive schema's depth is fixed by the
/// schema, independent of input size, so it decodes uncapped.
pub const MAX_RECURSIVE_DECODE_BYTES: usize = 16 * 1024;

/// Collect the names of every record/enum/fixed type DEFINED in a schema.
fn collect_named(v: &Value, names: &mut std::collections::HashSet<String>) {
    match v {
        Value::Object(o) => {
            if let (Some(Value::String(t)), Some(Value::String(n))) = (o.get("type"), o.get("name")) {
                if matches!(t.as_str(), "record" | "enum" | "fixed") {
                    names.insert(n.clone());
                }
            }
            o.values().for_each(|vv| collect_named(vv, names));
        }
        Value::Array(a) => a.iter().for_each(|it| collect_named(it, names)),
        _ => {}
    }
}

/// True if the schema USES (by name, in a `type` position or a union member) a
/// type it also defines — i.e. it may be recursive.
fn references_name(v: &Value, names: &std::collections::HashSet<String>) -> bool {
    match v {
        Value::String(s) => names.contains(s), // a bare name-reference
        Value::Array(a) => a.iter().any(|it| references_name(it, names)), // union members
        Value::Object(o) => {
            o.get("type").map_or(false, |t| references_name(t, names))
                || ["fields", "items", "values"]
                    .iter()
                    .any(|k| o.get(*k).map_or(false, |c| references_name(c, names)))
        }
        _ => false,
    }
}

/// Heuristic: could this schema be recursive (input-driven decode depth)? Over-
/// approximates — a non-recursive name reuse also flags — which is safe: it only
/// triggers the tighter input cap, never wrong output.
fn schema_is_recursive(schema_json: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(schema_json) else { return true }; // unparseable → be safe
    let mut names = std::collections::HashSet::new();
    collect_named(&v, &mut names);
    references_name(&v, &names)
}

/// Crash-safe `decode` for UNTRUSTED bytes. A NON-recursive schema's nesting is
/// bounded by the schema (small, size-independent), so it decodes directly +
/// uncapped — `MAX_JSON_DEPTH` still guards the output. A RECURSIVE schema can be
/// driven arbitrarily deep by crafted bytes, so it's capped (`MAX_RECURSIVE_DECODE_BYTES`)
/// and run on a 1 GiB-stack thread, keeping `from_avro_datum`'s build within the
/// stack. Use this at every untrusted-input boundary — never `decode` directly.
pub fn decode_guarded(bytes: &[u8], avro_schema_json: &str, wire: WireFormat) -> Result<Value, String> {
    if !schema_is_recursive(avro_schema_json) {
        return decode(bytes, avro_schema_json, wire);
    }
    if bytes.len() > MAX_RECURSIVE_DECODE_BYTES {
        return Err(format!(
            "recursive-schema payload {} bytes exceeds the {}-byte cap (recursion-bomb guard)",
            bytes.len(),
            MAX_RECURSIVE_DECODE_BYTES
        ));
    }
    let bytes = bytes.to_vec();
    let schema = avro_schema_json.to_string();
    std::thread::Builder::new()
        .name("avro-decode".into())
        .stack_size(1024 * 1024 * 1024) // 1 GiB virtual (lazy-committed) — survives the bounded build depth
        .spawn(move || decode(&bytes, &schema, wire))
        .map_err(|e| format!("spawn decode thread: {e}"))?
        .join()
        .map_err(|_| "decode thread crashed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use apache_avro::types::{Record, Value as Av};

    // The REAL saved JLR Account contract (Confluent envelope, v2, id=100003),
    // embedded at compile time — data-contract-first.
    const CONTRACT_V2: &str = include_str!(
        "../../../../connectors/kafka-confluent-rc/contracts/topic_account_jlr-value-v2.json"
    );

    /// Pull the bare Avro schema JSON out of the Confluent envelope `.schema`.
    fn account_schema_json() -> String {
        let envelope: Value = serde_json::from_str(CONTRACT_V2).expect("contract is JSON");
        envelope["schema"].as_str().expect("envelope has .schema string").to_string()
    }

    #[test]
    fn real_account_schema_parses() {
        // The 25-field nested schema (21 scalars + 4 record arrays) compiles.
        apache_avro::Schema::parse_str(&account_schema_json()).expect("Account schema parses");
    }

    #[test]
    fn round_trip_real_account_raw_wire() {
        // gate 3 — encode a real-schema Account datum, decode it back as RAW
        // (Em's producer's framing), verify the fields survive.
        let schema_json = account_schema_json();
        let schema = apache_avro::Schema::parse_str(&schema_json).unwrap();

        let mut rec = Record::new(&schema).expect("record for Account schema");
        // required (non-null) scalars
        rec.put("accountId", "ACC-001");
        rec.put("accountType", "personal");
        rec.put("organisationName1", "Jaguar Land Rover");
        rec.put("accountOrigin", "web");
        rec.put("country", "GB");
        // a couple of nullable scalars: one set, one null. A SET value in a
        // [null,string] union must name its branch (index 1); Av::Null
        // auto-resolves to branch 0.
        rec.put("firstName", Av::Union(1, Box::new(Av::String("Ada".to_string()))));
        rec.put("lastName", Av::Null);
        // the 4 nested-record arrays: empty (no need to build entries for the test)
        rec.put("telephone", Av::Array(vec![]));
        rec.put("email", Av::Array(vec![]));
        rec.put("accountRole", Av::Array(vec![]));
        rec.put("accountAddress", Av::Array(vec![]));
        // remaining [null,string] scalars default to null
        for f in [
            "title", "namePrefix", "middleName", "additionalLastName", "academicTitle",
            "nonAcademicTitle", "dateOfBirth", "employerName", "organisationName2",
            "preferredLanguage", "preferredContactMethod", "preferredContactTime",
            "gender", "generation",
        ] {
            rec.put(f, Av::Null);
        }

        let datum = apache_avro::to_avro_datum(&schema, rec).expect("encode Account datum");
        let decoded = decode(&datum, &schema_json, WireFormat::Raw).expect("decode raw avro");

        assert_eq!(decoded["accountId"], "ACC-001");
        assert_eq!(decoded["accountType"], "personal");
        assert_eq!(decoded["organisationName1"], "Jaguar Land Rover");
        assert_eq!(decoded["country"], "GB");
        assert_eq!(decoded["firstName"], "Ada"); // union [null,string] → string
        assert_eq!(decoded["lastName"], Value::Null); // union → null
        assert!(decoded["telephone"].is_array());
        assert_eq!(decoded["telephone"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn confluent_framing_strips_header() {
        let schema_json = account_schema_json();
        let schema = apache_avro::Schema::parse_str(&schema_json).unwrap();
        let mut rec = Record::new(&schema).unwrap();
        rec.put("accountId", "ACC-002");
        rec.put("accountType", "fleet");
        rec.put("organisationName1", "JLR");
        rec.put("accountOrigin", "api");
        rec.put("country", "DE");
        for f in [
            "title","namePrefix","firstName","middleName","lastName","additionalLastName",
            "academicTitle","nonAcademicTitle","dateOfBirth","employerName","organisationName2",
            "preferredLanguage","preferredContactMethod","preferredContactTime","gender","generation",
        ] { rec.put(f, Av::Null); }
        for f in ["telephone","email","accountRole","accountAddress"] { rec.put(f, Av::Array(vec![])); }

        let datum = apache_avro::to_avro_datum(&schema, rec).unwrap();
        // frame it Confluent-style: 0x00 + 4-byte BE schema id (100003) + datum
        let mut framed = vec![0x00u8];
        framed.extend_from_slice(&100003u32.to_be_bytes());
        framed.extend_from_slice(&datum);

        let decoded = decode(&framed, &schema_json, WireFormat::Confluent).expect("decode confluent");
        assert_eq!(decoded["accountId"], "ACC-002");
        // raw-decoding a confluent-framed payload fails fast (the header bytes
        // would corrupt the first field) — proves wire_format matters.
        let raw_attempt = decode(&datum, &schema_json, WireFormat::Confluent);
        assert!(raw_attempt.is_err(), "bare datum lacks the 0x00 magic byte");
    }

    #[test]
    fn wire_format_from_meta_defaults_confluent() {
        assert_eq!(WireFormat::from_meta(Some("raw")), WireFormat::Raw);
        assert_eq!(WireFormat::from_meta(Some("confluent")), WireFormat::Confluent);
        assert_eq!(WireFormat::from_meta(None), WireFormat::Confluent);
    }

    #[test]
    fn detects_recursive_schemas() {
        let node = r#"{"type":"record","name":"Node","fields":[{"name":"next","type":["null","Node"]}]}"#;
        assert!(schema_is_recursive(node), "self-referential record is recursive");
        // a flat record with an inline nested-record array is NOT recursive.
        let flat = r#"{"type":"record","name":"R","fields":[
            {"name":"a","type":"string"},
            {"name":"b","type":{"type":"array","items":{"type":"record","name":"E","fields":[{"name":"x","type":"int"}]}}}]}"#;
        assert!(!schema_is_recursive(flat), "inline nesting is not recursion");
        assert!(!schema_is_recursive(r#""string""#));
    }

    #[test]
    fn logical_types_decode_to_semantic_json() {
        use serde_json::json;
        // date (int logicalType date) → ISO string, not "Date(..)"
        assert_eq!(
            decode(&[254, 133, 2], r#"{"type":"int","logicalType":"date"}"#, WireFormat::Raw).unwrap(),
            json!("2015-11-28")
        );
        // time-millis → integer, not "TimeMillis(..)"
        assert_eq!(
            decode(&[158, 167, 1], r#"{"type":"int","logicalType":"time-millis"}"#, WireFormat::Raw).unwrap(),
            json!(10703)
        );
        // uuid → the uuid string, not "Uuid(..)"
        let mut uuid_bytes = vec![0x48u8]; // zigzag len 36
        uuid_bytes.extend_from_slice(b"123e4567-e89b-12d3-a456-426614174000");
        assert_eq!(
            decode(&uuid_bytes, r#"{"type":"string","logicalType":"uuid"}"#, WireFormat::Raw).unwrap(),
            json!("123e4567-e89b-12d3-a456-426614174000")
        );
    }

    #[test]
    fn trailing_bytes_are_a_loud_error() {
        // a Confluent-framed payload decoded as Raw: 0x00 reads as an empty
        // string, leaving 8 trailing bytes — must error, not silently truncate.
        let r = decode(&[0, 0, 0, 0, 1, 6, 102, 111, 111], r#""string""#, WireFormat::Raw);
        assert!(matches!(&r, Err(e) if e.contains("trailing")), "got {r:?}");
    }
}
