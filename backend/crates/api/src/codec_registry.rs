//! Purpose: the **codec registry** — the open-ended replacement for the closed
//! `data_type` enum (spec docs/internal/specs/type-definition.md §4.2 v1.1,
//! CAS_75A0D1FD). A `data_type` is now an OPAQUE codec id resolved against a
//! registry of registered `Codec`s, not a hardcoded `match`. The 9 builtin
//! formats register at startup as codecs; `decimal` is the first plugin codec;
//! a customer ships a new codec with a `register()` call and zero source edits
//! to any consumer — the disposability requirement ([[data-format-open-ended]]).
//! Doc: docs/internal/code/backend/api/codec_registry.md
//!
//! Concrete codecs (string / int / decimal / …) validate from the codec id
//! alone — pure, sync, no DB. Meta-codecs (avro / protobuf / …) decode a wire
//! payload against an EXTERNAL schema; their `is_meta` flag + the parse/serialize
//! surface land with the avro slice. Per [[data-format-open-ended]] the wire
//! `data_type` is already an open `String` (shipped abd971f), so swapping the
//! validator's `match` for this registry touches nothing downstream.
//!
//! No live HTTP consumer yet (the generic custom-object PATCH endpoint is
//! future); `field_validate::validate_format` delegates here today. The
//! module-level `allow(dead_code)` covers the not-yet-called surface
//! (`register`, `ids`, …) until that endpoint lands.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::Value;

use crate::field_validate::FieldError;

fn bad(m: impl Into<String>) -> FieldError {
    FieldError::BadValue(m.into())
}

fn as_str(v: &Value) -> Result<&str, FieldError> {
    v.as_str().ok_or_else(|| bad("expected a string"))
}

// ── concrete codec validators ───────────────────────────────────────────────
// Each is a pure `fn(value, options) -> Result<(), FieldError>`. Values may
// arrive as their native JSON type OR as a string (the cell-editor PATCHes
// contenteditable strings), so numeric/bool accept either form.

fn c_string(v: &Value, _: &[&str]) -> Result<(), FieldError> {
    as_str(v).map(|_| ())
}

fn c_int(v: &Value, _: &[&str]) -> Result<(), FieldError> {
    let ok = v.as_i64().is_some()
        || as_str(v).ok().and_then(|s| s.trim().parse::<i64>().ok()).is_some();
    ok.then_some(()).ok_or_else(|| bad("expected an integer"))
}

fn c_float(v: &Value, _: &[&str]) -> Result<(), FieldError> {
    let ok = v.as_f64().is_some()
        || as_str(v).ok().and_then(|s| s.trim().parse::<f64>().ok()).is_some();
    ok.then_some(()).ok_or_else(|| bad("expected a number"))
}

fn c_boolean(v: &Value, _: &[&str]) -> Result<(), FieldError> {
    let ok = v.is_boolean()
        || matches!(as_str(v).map(str::to_ascii_lowercase).as_deref(), Ok("true") | Ok("false"));
    ok.then_some(()).ok_or_else(|| bad("expected true or false"))
}

fn c_enum(v: &Value, options: &[&str]) -> Result<(), FieldError> {
    let s = as_str(v)?;
    options
        .contains(&s)
        .then_some(())
        .ok_or_else(|| bad(format!("must be one of: {}", options.join(", "))))
}

fn c_datetime(v: &Value, _: &[&str]) -> Result<(), FieldError> {
    let s = as_str(v)?;
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|_| ())
        .map_err(|_| bad("expected an ISO-8601 datetime"))
}

// `rid` validates SHAPE only (must be a string); cross-type existence is the
// referential layer in `field_validate::validate_ref` (async, DB).
fn c_rid(v: &Value, _: &[&str]) -> Result<(), FieldError> {
    as_str(v).map(|_| ())
}

fn c_json(v: &Value, _: &[&str]) -> Result<(), FieldError> {
    match v {
        // an object/array/scalar is already valid; a string must itself parse.
        Value::String(s) => serde_json::from_str::<Value>(s)
            .map(|_| ())
            .map_err(|_| bad("expected valid JSON")),
        _ => Ok(()),
    }
}

/// Wire-as-string decimal (the banking footgun: `float` corrupts money sums).
/// Accepts a JSON number or a `[+-]?digits[.digits]` string — stored as the
/// string to avoid JS float coercion. The codec only validates here; exact
/// arithmetic is the storage layer's (PG `NUMERIC`).
fn c_decimal(v: &Value, _: &[&str]) -> Result<(), FieldError> {
    match v {
        Value::Number(_) => Ok(()),
        Value::String(s) => is_decimal_str(s.trim())
            .then_some(())
            .ok_or_else(|| bad("expected a decimal (e.g. \"10.00\")")),
        _ => Err(bad("expected a decimal")),
    }
}

// `avro` is a META-codec: its bytes→Value decode lives in
// [codec_avro](crate::codec_avro) (schema resolved from the connector's saved
// contract). The registry's `validate` runs POST-decode — a decoded Avro record
// is a JSON object.
fn c_avro(v: &Value, _: &[&str]) -> Result<(), FieldError> {
    if v.is_object() {
        Ok(())
    } else {
        Err(bad("expected a decoded avro record (object)"))
    }
}

fn is_decimal_str(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let s = s.strip_prefix('+').or_else(|| s.strip_prefix('-')).unwrap_or(s);
    let mut parts = s.split('.');
    let int_part = parts.next().unwrap_or("");
    let frac_part = parts.next();
    if parts.next().is_some() {
        return false; // more than one '.'
    }
    let digits = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
    digits(int_part) && frac_part.map_or(true, digits)
}

// ── the registry ─────────────────────────────────────────────────────────────

/// One registered codec. `validate` is the pure value-shape check; `is_meta`
/// marks schema-resolving codecs (avro/protobuf) whose parse/serialize surface
/// lands with the avro slice.
#[derive(Clone)]
pub struct Codec {
    pub id:       &'static str,
    pub validate: fn(&Value, &[&str]) -> Result<(), FieldError>,
    pub is_meta:  bool,
}

/// An open map of `codec_id -> Codec`. Builtins seed it; `register` adds more
/// (custom objects / new connectors) without touching any consumer.
pub struct CodecRegistry {
    codecs: HashMap<&'static str, Codec>,
}

impl CodecRegistry {
    pub fn new() -> Self {
        Self { codecs: HashMap::new() }
    }

    /// A registry seeded with the builtin codecs (the former closed enum).
    pub fn with_builtins() -> Self {
        let mut r = Self::new();
        for c in builtin_codecs() {
            r.register(c);
        }
        r
    }

    pub fn register(&mut self, codec: Codec) {
        self.codecs.insert(codec.id, codec);
    }

    pub fn get(&self, id: &str) -> Option<&Codec> {
        self.codecs.get(id)
    }

    /// Validate `value` against codec `id`. A JSON `null` is "clear the field" →
    /// Ok (nullability is the `required` flag's job). An unregistered id →
    /// `BadValue("codec_not_registered: …")` (§4.2 gate 5 — no silent corruption).
    pub fn validate(&self, id: &str, value: &Value, options: &[&str]) -> Result<(), FieldError> {
        if value.is_null() {
            return Ok(());
        }
        match self.get(id) {
            Some(c) => (c.validate)(value, options),
            None => Err(bad(format!("codec_not_registered: {id}"))),
        }
    }

    /// Registered codec ids — for `/admin` introspection / audit.
    pub fn ids(&self) -> Vec<&'static str> {
        let mut v: Vec<_> = self.codecs.keys().copied().collect();
        v.sort_unstable();
        v
    }
}

impl Default for CodecRegistry {
    fn default() -> Self {
        Self::with_builtins()
    }
}

/// The 9 v1 formats + `decimal` (first plugin), registered at startup. These
/// stop being a closed enum and become "the v1 known-codec set".
fn builtin_codecs() -> Vec<Codec> {
    vec![
        Codec { id: "string",   validate: c_string,   is_meta: false },
        Codec { id: "markdown", validate: c_string,   is_meta: false },
        Codec { id: "int",      validate: c_int,      is_meta: false },
        Codec { id: "float",    validate: c_float,    is_meta: false },
        Codec { id: "boolean",  validate: c_boolean,  is_meta: false },
        Codec { id: "enum",     validate: c_enum,     is_meta: false },
        Codec { id: "datetime", validate: c_datetime, is_meta: false },
        Codec { id: "json",     validate: c_json,     is_meta: false },
        Codec { id: "rid",      validate: c_rid,      is_meta: false },
        Codec { id: "decimal",  validate: c_decimal,  is_meta: false },
        // meta-codec: decode in codec_avro; validate runs post-decode.
        Codec { id: "avro",     validate: c_avro,     is_meta: true  },
    ]
}

/// The process-wide builtin registry. `field_validate::validate_format`
/// delegates here. When the generic custom-object PATCH endpoint lands, it
/// resolves codecs through this (or a per-tenant registry layered on top).
pub fn registry() -> &'static CodecRegistry {
    static REG: OnceLock<CodecRegistry> = OnceLock::new();
    REG.get_or_init(CodecRegistry::with_builtins)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builtin_parity_with_the_old_match() {
        let r = registry();
        // gate 1 — every former enum arm still validates identically.
        assert!(r.validate("string", &json!("hi"), &[]).is_ok());
        assert!(r.validate("string", &json!(5), &[]).is_err());
        assert!(r.validate("int", &json!("42"), &[]).is_ok());
        assert!(r.validate("int", &json!("4.2"), &[]).is_err());
        assert!(r.validate("float", &json!("4.2"), &[]).is_ok());
        assert!(r.validate("boolean", &json!("TRUE"), &[]).is_ok());
        assert!(r.validate("enum", &json!("bug"), &["bug", "task"]).is_ok());
        assert!(r.validate("enum", &json!("x"), &["bug", "task"]).is_err());
        assert!(r.validate("datetime", &json!("2026-06-01T00:00:00Z"), &[]).is_ok());
        assert!(r.validate("json", &json!("{bad"), &[]).is_err());
        assert!(r.validate("rid", &json!("USR_1"), &[]).is_ok());
        // null clears for any codec.
        assert!(r.validate("int", &Value::Null, &[]).is_ok());
    }

    #[test]
    fn decimal_plugin_codec() {
        let r = registry();
        // gate 2 — decimal as a registered codec; wire-as-string, no float corruption.
        assert!(r.validate("decimal", &json!("10.00"), &[]).is_ok());
        assert!(r.validate("decimal", &json!("-0.01"), &[]).is_ok());
        assert!(r.validate("decimal", &json!(42), &[]).is_ok());
        assert!(r.validate("decimal", &json!("1.2.3"), &[]).is_err());
        assert!(r.validate("decimal", &json!("abc"), &[]).is_err());
        assert!(r.validate("decimal", &json!(""), &[]).is_err());
    }

    #[test]
    fn customer_codec_registers_without_touching_consumers() {
        // gate 4 — a never-seen codec works with zero source edits, same path.
        fn quantum_state(v: &Value, _: &[&str]) -> Result<(), FieldError> {
            match v.as_str() {
                Some("up") | Some("down") | Some("superposed") => Ok(()),
                _ => Err(FieldError::BadValue("expected up | down | superposed".into())),
            }
        }
        let mut r = CodecRegistry::with_builtins();
        r.register(Codec { id: "quantum_state", validate: quantum_state, is_meta: false });
        assert!(r.validate("quantum_state", &json!("superposed"), &[]).is_ok());
        assert!(r.validate("quantum_state", &json!("sideways"), &[]).is_err());
        // builtins still present alongside the custom codec.
        assert!(r.validate("string", &json!("hi"), &[]).is_ok());
    }

    #[test]
    fn unknown_codec_is_a_clean_error_not_silent() {
        // gate 5 — unregistered codec id → BadValue echoing the id, no corruption.
        let err = registry().validate("definitely_not_registered", &json!("x"), &[]);
        assert!(matches!(&err, Err(FieldError::BadValue(m)) if m.contains("definitely_not_registered")));
    }

    #[test]
    fn ids_lists_the_builtins() {
        let ids = registry().ids();
        for want in ["string", "int", "float", "boolean", "enum", "datetime", "json", "rid", "markdown", "decimal"] {
            assert!(ids.contains(&want), "missing builtin codec: {want}");
        }
    }
}
