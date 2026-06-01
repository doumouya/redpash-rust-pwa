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
    Ok(avro_to_json(avro))
}

/// Convert an `apache_avro::types::Value` to `serde_json::Value`. Unions unwrap
/// to their inner branch (so `[null,string]` reads as the string or null);
/// logical/temporal types fall back to a string rendering rather than panicking.
fn avro_to_json(v: apache_avro::types::Value) -> Value {
    use apache_avro::types::Value as Av;
    match v {
        Av::Null => Value::Null,
        Av::Boolean(b) => Value::Bool(b),
        Av::Int(i) => Value::from(i),
        Av::Long(i) => Value::from(i),
        Av::Float(f) => num(f as f64),
        Av::Double(f) => num(f),
        Av::String(s) | Av::Enum(_, s) => Value::String(s),
        Av::Bytes(b) | Av::Fixed(_, b) => Value::String(String::from_utf8_lossy(&b).into_owned()),
        Av::Union(_, inner) => avro_to_json(*inner),
        Av::Array(items) => Value::Array(items.into_iter().map(avro_to_json).collect()),
        Av::Map(m) => Value::Object(m.into_iter().map(|(k, v)| (k, avro_to_json(v))).collect()),
        Av::Record(fields) => Value::Object(fields.into_iter().map(|(k, v)| (k, avro_to_json(v))).collect()),
        other => Value::String(format!("{other:?}")),
    }
}

fn num(f: f64) -> Value {
    Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
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
}
