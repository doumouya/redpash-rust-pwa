//! Purpose: the **field-validation pipeline** + open **rule registry** (spec
//! §v2, CAS_C7AEBE83). Two tiers, mirroring the cleanness scorer's
//! `value_quality × structural` model (`data/src/structure.rs`):
//!   • Tier 1 — HARD contract gate → `errors[]`; non-empty ⇒ HTTP 400.
//!       1a codec shape (delegates to `codec_registry`, short-circuits),
//!       1b each `ValidateRule` resolved against this registry (collect-all).
//!   • Tier 2 — SOFT suspicion layer → `warnings[]` + `confidence`; never
//!       blocks. The field-level twin of `StructureFlags` (wired in phase 5).
//! Doc: docs/internal/code/backend/api/validate_rules.md
//!
//! Rule `kind` is an OPEN string resolved against the registry — NEVER a closed
//! `match` (same open-ended contract as `data_type`/codecs). A new rule kind is
//! one `register()` line, zero edits to the pipeline. This is the answer to
//! "edge cases we haven't thought of yet": the MECHANISM is general; an unknown
//! constraint becomes a registered rule or (tier 2) a registered detector, and a
//! future Copilot/Gemini challenge becomes a new labelled row in
//! `tools/wasm-bench/validate-calibration.py`, not a redesign.
//!
//! Unwired to HTTP until `POST /api/demo/validate` (phase 6) + the future
//! custom-object PATCH endpoint; `allow(dead_code)` covers the staged surface.
#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use serde::Serialize;
use serde_json::Value;

use shared::type_def::ValidateRule;

/// The sibling-field values of the row being written — cross-field rules
/// (`expression`) read other fields from here. Field key → proposed value.
pub type Row = BTreeMap<String, Value>;

/// Kind-specific rule payload (`ValidateRule.params`).
pub type Params = BTreeMap<String, Value>;

// ── result types ─────────────────────────────────────────────────────────────

/// A Tier-1 hard violation → the 400 body `{error, field, rule_code, message}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RuleViolation {
    pub field:     String,
    pub rule_code: String,
    pub message:   String,
}

/// A Tier-2 soft warning — the field-level twin of a `StructureFlags` reason +
/// penalty. `weight ∈ [0,1]` feeds `confidence`. Never blocks a write.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Suspicion {
    pub field:    String,
    pub detector: String,
    pub reason:   String,
    pub weight:   f32,
}

/// The composed outcome of validating one field's value. `errors` non-empty ⇒
/// reject 400; otherwise the write proceeds and `warnings`/`confidence` ride
/// the 200 response (the parse-endpoint pattern: save + surface the smell).
#[derive(Debug, Clone, Serialize)]
pub struct FieldOutcome {
    pub errors:     Vec<RuleViolation>,
    pub warnings:   Vec<Suspicion>,
    /// `1.0 − (Σ warning weight).min(1.0)` — the `StructureFlags::penalty()`
    /// algebra, inverted to a confidence.
    pub confidence: f32,
}

impl FieldOutcome {
    fn empty() -> Self {
        Self { errors: Vec::new(), warnings: Vec::new(), confidence: 1.0 }
    }
    pub fn is_ok(&self) -> bool {
        self.errors.is_empty()
    }
    /// Recompute confidence from current warnings. Called once the suspicion
    /// layer has run.
    fn finalize(mut self) -> Self {
        let docked: f32 = self.warnings.iter().map(|s| s.weight).sum::<f32>().min(1.0);
        self.confidence = (1.0 - docked).clamp(0.0, 1.0);
        self
    }
}

// ── the rule registry ────────────────────────────────────────────────────────

/// One rule check's verdict. `Pass`/`Fail` are about the VALUE; `Malformed`
/// flags a bad rule AUTHORING (e.g. a `range` with a non-numeric `min`) — a bug
/// in the TypeDefinition, surfaced distinctly so it's not confused with a value
/// violation.
pub enum RuleCheck {
    Pass,
    Fail,
    Malformed(String),
}

/// One registered rule kind. `check` is pure + sync (no DB, no I/O) and may read
/// sibling fields from `Row` for cross-field rules.
#[derive(Clone)]
pub struct Rule {
    pub kind:  &'static str,
    pub check: fn(&Value, &Params, &Row) -> RuleCheck,
}

/// Open map of `rule_kind → Rule`. Builtins seed it; `register` adds more
/// (custom verticals / future rule kinds) without touching the pipeline.
pub struct RuleRegistry {
    rules: HashMap<&'static str, Rule>,
}

impl RuleRegistry {
    pub fn new() -> Self {
        Self { rules: HashMap::new() }
    }
    pub fn with_builtins() -> Self {
        let mut r = Self::new();
        for rule in builtin_rules() {
            r.register(rule);
        }
        r
    }
    pub fn register(&mut self, rule: Rule) {
        self.rules.insert(rule.kind, rule);
    }
    pub fn get(&self, kind: &str) -> Option<&Rule> {
        self.rules.get(kind)
    }
    pub fn kinds(&self) -> Vec<&'static str> {
        let mut v: Vec<_> = self.rules.keys().copied().collect();
        v.sort_unstable();
        v
    }
}

impl Default for RuleRegistry {
    fn default() -> Self {
        Self::with_builtins()
    }
}

/// Process-wide rule registry. `expression` registers here in phase 3; `decimal`
/// in phase 4; `pattern` once the `regex` direct-dep is signed off.
pub fn registry() -> &'static RuleRegistry {
    static REG: OnceLock<RuleRegistry> = OnceLock::new();
    REG.get_or_init(RuleRegistry::with_builtins)
}

fn builtin_rules() -> Vec<Rule> {
    vec![
        Rule { kind: "range",       check: r_range },
        Rule { kind: "length",      check: r_length },
        Rule { kind: "enum_subset", check: r_enum_subset },
        // "pattern"     — pending the regex direct-dep sign-off (regex is in-tree).
        // "expression"  — registered in phase 3 (validate_expr.rs).
        // "decimal"     — registered in phase 4 (scale/currency).
    ]
}

// ── builtin rule checks ──────────────────────────────────────────────────────

/// Read a numeric value from a JSON number OR a numeric string (the cell-editor
/// PATCHes contenteditable strings). None ⇒ not numeric.
fn value_as_f64(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
}

/// `range { min?, max? }` — numeric bounds (inclusive). A non-numeric value is a
/// Fail (the codec gate should have caught it; defensive here).
fn r_range(v: &Value, p: &Params, _: &Row) -> RuleCheck {
    let Some(n) = value_as_f64(v) else { return RuleCheck::Fail };
    if let Some(min) = p.get("min").and_then(Value::as_f64) {
        if n < min {
            return RuleCheck::Fail;
        }
    }
    if let Some(max) = p.get("max").and_then(Value::as_f64) {
        if n > max {
            return RuleCheck::Fail;
        }
    }
    RuleCheck::Pass
}

/// `length { min?, max? }` — character count of the string form (Unicode chars,
/// not bytes). Non-string values are stringified (defensive).
fn r_length(v: &Value, p: &Params, _: &Row) -> RuleCheck {
    let s = match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let len = s.chars().count() as i64;
    if let Some(min) = p.get("min").and_then(Value::as_i64) {
        if len < min {
            return RuleCheck::Fail;
        }
    }
    if let Some(max) = p.get("max").and_then(Value::as_i64) {
        if len > max {
            return RuleCheck::Fail;
        }
    }
    RuleCheck::Pass
}

/// `enum_subset { values: [..] }` — value must be one of `values`. Distinct from
/// the `enum` codec: this restricts an already-typed field to a subset (e.g. a
/// status field whose allowed transitions narrow per vertical).
fn r_enum_subset(v: &Value, p: &Params, _: &Row) -> RuleCheck {
    let Some(s) = v.as_str() else { return RuleCheck::Fail };
    match p.get("values").and_then(Value::as_array) {
        Some(vals) => {
            if vals.iter().any(|x| x.as_str() == Some(s)) {
                RuleCheck::Pass
            } else {
                RuleCheck::Fail
            }
        }
        None => RuleCheck::Malformed("enum_subset rule needs params.values: [..]".into()),
    }
}

// ── the pipeline ──────────────────────────────────────────────────────────────

/// Validate one field's proposed `value` against its `data_type` (+ `options`)
/// and its `rules`, with `row` carrying sibling field values for cross-field
/// rules. Tier 1 only in phase 2 (Tier 2 detectors wire in phase 5).
///
/// - Gate 1a (codec shape) short-circuits: a wrong-shape value can't meaningfully
///   run range/length.
/// - Gate 1b (rules) collects ALL violations (the FE shows every broken
///   constraint at once — like `StructureFlags` collects all reasons).
/// - A JSON `null` clears the field (nullability is `required`'s job) → no rules.
pub fn validate_value(
    data_type: &str,
    options:   &[&str],
    field_key: &str,
    rules:     &[ValidateRule],
    value:     &Value,
    row:       &Row,
) -> FieldOutcome {
    let mut out = FieldOutcome::empty();

    // ── Gate 1a — codec shape (short-circuit on failure) ──
    if let Err(e) = crate::codec_registry::registry().validate(data_type, value, options) {
        let message = match e {
            crate::field_validate::FieldError::BadValue(m)
            | crate::field_validate::FieldError::MissingRef(m) => m,
        };
        out.errors.push(RuleViolation {
            field:     field_key.to_string(),
            rule_code: "data_type".to_string(),
            message,
        });
        return out.finalize();
    }

    // null clears — no value to constrain.
    if value.is_null() {
        return out.finalize();
    }

    // ── Gate 1b — rules (collect-all) ──
    let reg = registry();
    for rule in rules {
        match reg.get(&rule.kind) {
            Some(r) => match (r.check)(value, &rule.params, row) {
                RuleCheck::Pass => {}
                RuleCheck::Fail => out.errors.push(RuleViolation {
                    field:     field_key.to_string(),
                    rule_code: rule.code.clone(),
                    message:   rule.message.clone(),
                }),
                RuleCheck::Malformed(why) => out.errors.push(RuleViolation {
                    field:     field_key.to_string(),
                    rule_code: "invalid_rule".to_string(),
                    message:   format!("rule '{}' is malformed: {why}", rule.kind),
                }),
            },
            None => out.errors.push(RuleViolation {
                field:     field_key.to_string(),
                rule_code: "unknown_rule".to_string(),
                message:   format!("unknown validate rule kind: {}", rule.kind),
            }),
        }
    }

    // Tier 2 (detectors) wires in phase 5; confidence is 1.0 until then.
    out.finalize()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rule(kind: &str, params: serde_json::Value, code: &str) -> ValidateRule {
        ValidateRule {
            kind: kind.to_string(),
            params: params.as_object().unwrap().clone().into_iter().collect(),
            code: code.to_string(),
            message: format!("{code} failed"),
        }
    }

    fn no_row() -> Row {
        Row::new()
    }

    #[test]
    fn range_min_max() {
        let r = vec![rule("range", json!({ "min": 1 }), "must_be_positive")];
        // value 0 < min 1 → one violation with the authored code.
        let out = validate_value("int", &[], "list_price", &r, &json!(0), &no_row());
        assert!(!out.is_ok());
        assert_eq!(out.errors[0].rule_code, "must_be_positive");
        // value 5 ≥ min 1 → clean.
        assert!(validate_value("int", &[], "list_price", &r, &json!(5), &no_row()).is_ok());
    }

    #[test]
    fn length_max() {
        let r = vec![rule("length", json!({ "max": 5 }), "too_long")];
        assert!(validate_value("string", &[], "name", &r, &json!("abc"), &no_row()).is_ok());
        assert!(!validate_value("string", &[], "name", &r, &json!("abcdef"), &no_row()).is_ok());
    }

    #[test]
    fn enum_subset_membership() {
        let r = vec![rule("enum_subset", json!({ "values": ["open", "closed"] }), "bad_status")];
        assert!(validate_value("string", &[], "status", &r, &json!("open"), &no_row()).is_ok());
        assert!(!validate_value("string", &[], "status", &r, &json!("pending"), &no_row()).is_ok());
    }

    #[test]
    fn codec_gate_short_circuits_before_rules() {
        // value isn't an int at all → data_type violation, rules don't run.
        let r = vec![rule("range", json!({ "min": 1 }), "must_be_positive")];
        let out = validate_value("int", &[], "list_price", &r, &json!("not a number"), &no_row());
        assert_eq!(out.errors.len(), 1);
        assert_eq!(out.errors[0].rule_code, "data_type");
    }

    #[test]
    fn rules_collect_all_violations() {
        // two failing rules on one field → BOTH surfaced (collect-all).
        let r = vec![
            rule("range",  json!({ "min": 10 }), "too_small"),
            rule("length", json!({ "max": 1 }),  "too_long"),
        ];
        // "5" parses as int 5 (< 10 → too_small) and is 1 char... use "5" → len 1 ok;
        // use value 5 with length max 1 on its string form "5" (len 1) ⇒ only range fails.
        let out = validate_value("int", &[], "n", &r, &json!(5), &no_row());
        assert_eq!(out.errors.len(), 1, "only range should fail here");
        // now a 2-char-too-small value: 7 is 1 char; use min 10 + length max 0.
        let r2 = vec![
            rule("range",  json!({ "min": 10 }), "too_small"),
            rule("length", json!({ "max": 0 }),  "too_long"),
        ];
        let out2 = validate_value("int", &[], "n", &r2, &json!(5), &no_row());
        assert_eq!(out2.errors.len(), 2, "both rules should surface");
    }

    #[test]
    fn null_clears_and_skips_rules() {
        let r = vec![rule("range", json!({ "min": 1 }), "must_be_positive")];
        assert!(validate_value("int", &[], "x", &r, &Value::Null, &no_row()).is_ok());
    }

    #[test]
    fn unknown_rule_kind_is_loud() {
        let r = vec![rule("teleport", json!({}), "whatever")];
        let out = validate_value("string", &[], "x", &r, &json!("hi"), &no_row());
        assert_eq!(out.errors[0].rule_code, "unknown_rule");
    }

    #[test]
    fn custom_rule_registers_without_touching_pipeline() {
        // a never-seen rule kind works through the same pipeline once registered.
        fn r_even(v: &Value, _: &Params, _: &Row) -> RuleCheck {
            match value_as_f64(v) {
                Some(n) if (n as i64) % 2 == 0 => RuleCheck::Pass,
                Some(_) => RuleCheck::Fail,
                None => RuleCheck::Fail,
            }
        }
        let mut reg = RuleRegistry::with_builtins();
        reg.register(Rule { kind: "even", check: r_even });
        assert!(matches!(
            (reg.get("even").unwrap().check)(&json!(4), &Params::new(), &no_row()),
            RuleCheck::Pass
        ));
        assert!(matches!(
            (reg.get("even").unwrap().check)(&json!(3), &Params::new(), &no_row()),
            RuleCheck::Fail
        ));
        // builtins still present.
        assert!(reg.get("range").is_some());
    }
}
