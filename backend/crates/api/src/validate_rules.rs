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
        Rule { kind: "expression",  check: crate::validate_expr::r_expression },
        Rule { kind: "decimal",     check: r_decimal },
        Rule { kind: "pattern",     check: r_pattern },
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
    // NaN / ±Inf sit outside ANY finite range, and `NaN < x` / `NaN > x` are both
    // false — so without this guard a "NaN" float slips every bound. Reject it.
    if !n.is_finite() {
        return RuleCheck::Fail;
    }
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

/// `decimal { scale?, currency? }` — the money contract (reborn `CAS_AE8F3F2D`,
/// as an OPEN rule param, never a fixed type). Enforces **scale**: a value with
/// more fractional digits than `scale` is a hard Fail (XOF `scale:0` rejects
/// `1.5`; USD `scale:2` rejects `1.999`) — loss-of-precision is rejected, never
/// silently truncated (the codec_avro "prevent, don't recover" lesson, applied
/// to money). `currency` is an opaque ISO-4217 string (3 uppercase letters) —
/// never a Rust enum, so XOF / JPY / BHD all work without a source change; it
/// rides for FE formatting + messages. With no `scale`, the rule is pure shape.
fn r_decimal(v: &Value, p: &Params, _: &Row) -> RuleCheck {
    let s = match v {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => return RuleCheck::Fail,
    };
    if !crate::codec_registry::is_decimal_str(&s) {
        return RuleCheck::Fail;
    }
    // currency: opaque shape check only (3 ASCII uppercase letters) when present.
    if let Some(cur) = p.get("currency").and_then(Value::as_str) {
        let ok = cur.len() == 3 && cur.bytes().all(|b| b.is_ascii_uppercase());
        if !ok {
            return RuleCheck::Malformed(format!("currency must be an ISO-4217 code (got \"{cur}\")"));
        }
    }
    // scale: reject more *significant* fractional digits than declared. Trailing
    // zeros are cosmetic, not precision (`10.500` == `10.50` == scale 2), so
    // strip them before counting — else a clean value false-rejects.
    if let Some(scale) = p.get("scale").and_then(Value::as_u64) {
        let frac = s.split_once('.').map_or(0, |(_, f)| f.trim_end_matches('0').len());
        if frac as u64 > scale {
            return RuleCheck::Fail;
        }
    }
    RuleCheck::Pass
}

/// `pattern { pattern: "<regex>" }` — value (a string) must match. Uses the
/// `regex` crate: RE2-style **linear-time** matching, so a crafted value/pattern
/// can't catastrophically backtrack (no ReDoS — the safe choice over a
/// hand-rolled backtracker). Two prevent-don't-recover bounds: the pattern
/// source is length-capped, and the compiled program is `size_limit`-capped, so
/// a giant authored pattern can't blow memory. A bad regex is `Malformed` (an
/// authoring bug), not a value `Fail`.
fn r_pattern(v: &Value, p: &Params, _: &Row) -> RuleCheck {
    const MAX_PATTERN_LEN: usize = 512;
    const MAX_COMPILED_BYTES: usize = 1 << 20; // 1 MiB compiled program ceiling
    let Some(pat) = p.get("pattern").and_then(Value::as_str) else {
        return RuleCheck::Malformed("pattern rule needs params.pattern: \"<regex>\"".into());
    };
    if pat.len() > MAX_PATTERN_LEN {
        return RuleCheck::Malformed(format!("pattern too long (> {MAX_PATTERN_LEN} bytes)"));
    }
    let Some(s) = v.as_str() else { return RuleCheck::Fail }; // pattern applies to strings
    match regex::RegexBuilder::new(pat).size_limit(MAX_COMPILED_BYTES).build() {
        Ok(re) => if re.is_match(s) { RuleCheck::Pass } else { RuleCheck::Fail },
        Err(e) => RuleCheck::Malformed(format!("invalid regex: {e}")),
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

    // ── Gate 1b — rules (collect-all) ──
    // A JSON null CLEARS the field (nullability is `required`'s job), so the
    // value-shape rules (range/length/pattern/decimal/enum_subset) are skipped
    // on null. But `expression` rules are cross-field and null-AWARE (the spec's
    // own `sold_at == null || …`), so they run even on null — a rule that
    // evaluates false on a null value still rejects.
    let is_null = value.is_null();
    let reg = registry();
    for rule in rules {
        if is_null && rule.kind != "expression" {
            continue;
        }
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

    // ── Tier 2 — suspicion detectors (never block; warn + dock confidence) ──
    // Runs on a shape-valid, non-null value even when Tier 1 passed — a value
    // can satisfy the contract and still smell wrong. This tier is what catches
    // UNKNOWN edge cases by general detectors (raw-vs-parsed, drift), not named
    // rules.
    if !is_null {
        let ctx = DetectCtx { field_key, data_type, value };
        for d in detectors() {
            if let Some(s) = d.inspect(&ctx) {
                out.warnings.push(s);
            }
        }
    }
    out.finalize()
}

// ── Tier 2 — open detector registry (the field-level StructureFlags) ─────────

/// What a detector inspects: the field + its proposed value. The value AS A
/// STRING is the raw wire form (the cell-editor PATCHes contenteditable
/// strings), so raw-vs-parsed detectors read `value.as_str()`.
pub struct DetectCtx<'a> {
    pub field_key: &'a str,
    pub data_type: &'a str,
    pub value:     &'a Value,
}

/// A Tier-2 suspicion detector — the field-level analog of one `StructureFlags`
/// axis. Returns a graded `Suspicion` or `None`. Pluggable: a new detector is
/// one struct + one slot in `detectors()`, zero pipeline edits.
pub trait FieldDetector: Send + Sync {
    fn id(&self) -> &'static str;
    fn inspect(&self, ctx: &DetectCtx) -> Option<Suspicion>;
}

/// **Raw-vs-parsed coercion loss** — the single most general detector, ported
/// from `structure.rs`'s leading-zero check. A string value typed `int` loses
/// leading zeros / a `+` sign when stored (`"07920"` → `7920`), destroying
/// identity (zip / code / badge id). Caught by re-serializing the parse and
/// comparing to the raw — no named rule required.
struct CoercionLoss;
impl FieldDetector for CoercionLoss {
    fn id(&self) -> &'static str { "coercion_loss" }
    fn inspect(&self, ctx: &DetectCtx) -> Option<Suspicion> {
        let raw = ctx.value.as_str()?; // only a string value can lose form on store
        let canonical = match ctx.data_type {
            // int: leading zero / sign / surrounding whitespace all vanish.
            "int" => raw.trim().parse::<i64>().ok()?.to_string(),
            // boolean: "TRUE"/"True"/" true " all normalize to lowercase "true".
            "boolean" => {
                let low = raw.trim().to_ascii_lowercase();
                if low != "true" && low != "false" {
                    return None;
                }
                low
            }
            _ => return None,
        };
        if canonical != raw {
            return Some(Suspicion {
                field:    ctx.field_key.to_string(),
                detector: "coercion_loss".to_string(),
                reason:   format!("raw {raw:?} normalizes to {canonical:?} on store — formatting/identity lost; use data_type \"string\" to preserve it"),
                weight:   0.3,
            });
        }
        None
    }
}

/// **Invisible characters** — zero-width / bidi-override / control chars hiding in
/// a string (security: a username with a U+200B, a BOM, an RTL override). Flags
/// the genuinely-invisible set but NOT ZWJ/ZWNJ (U+200C/200D — legitimate in
/// emoji + many scripts) and NOT `\t\n\r` — so real text doesn't false-trip.
struct InvisibleChars;
fn is_suspicious_invisible(c: char) -> bool {
    matches!(c,
        '\u{200B}'            // zero-width space
        | '\u{200E}' | '\u{200F}'                       // LRM / RLM
        | '\u{202A}'..='\u{202E}'                       // bidi embeddings/overrides
        | '\u{2060}'          // word joiner
        | '\u{2066}'..='\u{2069}'                       // bidi isolates
        | '\u{FEFF}'          // BOM / zero-width no-break space
    ) || (c.is_control() && !matches!(c, '\t' | '\n' | '\r'))
}
impl FieldDetector for InvisibleChars {
    fn id(&self) -> &'static str { "invisible_chars" }
    fn inspect(&self, ctx: &DetectCtx) -> Option<Suspicion> {
        if !matches!(ctx.data_type, "string" | "markdown") {
            return None;
        }
        let s = ctx.value.as_str()?;
        if s.chars().any(is_suspicious_invisible) {
            return Some(Suspicion {
                field:    ctx.field_key.to_string(),
                detector: "invisible_chars".to_string(),
                reason:   "value contains zero-width / bidi / control characters — invisible, often a paste artifact or an attack".to_string(),
                weight:   0.3,
            });
        }
        None
    }
}

/// **Primitive obsession** — a string field holding structured data: valid JSON
/// (object/array) or base64. A schema smell — the data model is hiding a type
/// inside a string. Soft hint. base64 detection is conservative (≥16 chars, len
/// %4==0, base64 charset, contains one of `+/=` so plain words don't match, and
/// it actually decodes) to keep false positives low.
struct PrimitiveObsession;
fn looks_base64(s: &str) -> bool {
    use base64::Engine;
    s.len() >= 16
        && s.len() % 4 == 0
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
        && s.bytes().any(|b| matches!(b, b'+' | b'/' | b'='))
        && base64::engine::general_purpose::STANDARD.decode(s).is_ok()
}
impl FieldDetector for PrimitiveObsession {
    fn id(&self) -> &'static str { "primitive_obsession" }
    fn inspect(&self, ctx: &DetectCtx) -> Option<Suspicion> {
        if !matches!(ctx.data_type, "string" | "markdown") {
            return None;
        }
        let s = ctx.value.as_str()?;
        let is_json_struct = matches!(
            serde_json::from_str::<Value>(s),
            Ok(Value::Object(_)) | Ok(Value::Array(_))
        );
        if is_json_struct || looks_base64(s) {
            let kind = if is_json_struct { "JSON" } else { "base64" };
            return Some(Suspicion {
                field:    ctx.field_key.to_string(),
                detector: "primitive_obsession".to_string(),
                reason:   format!("string field holds {kind} — structured data hidden in a string (consider a typed field)"),
                weight:   0.2,
            });
        }
        None
    }
}

/// **Type drift** — a value that *looks* like a structured type sitting in a
/// `string`/`markdown` field (a date stored as text). Soft hint (low weight),
/// reusing `data::dtype::classify_cell` so file- and field-level suspicion stay
/// single-sourced.
struct Drift;
impl FieldDetector for Drift {
    fn id(&self) -> &'static str { "drift" }
    fn inspect(&self, ctx: &DetectCtx) -> Option<Suspicion> {
        if !matches!(ctx.data_type, "string" | "markdown") {
            return None;
        }
        let s = ctx.value.as_str()?;
        if matches!(data::dtype::classify_cell(s), data::dtype::CellKind::Date) {
            return Some(Suspicion {
                field:    ctx.field_key.to_string(),
                detector: "drift".to_string(),
                reason:   format!("value \"{s}\" looks like a date but the field is typed string"),
                weight:   0.1,
            });
        }
        None
    }
}

/// The process-wide detector set. A new detector slots in here — zero edits to
/// the pipeline (the open-registry payoff, applied to Tier 2).
pub fn detectors() -> &'static [Box<dyn FieldDetector>] {
    static D: OnceLock<Vec<Box<dyn FieldDetector>>> = OnceLock::new();
    D.get_or_init(|| {
        let v: Vec<Box<dyn FieldDetector>> = vec![
            Box::new(CoercionLoss),
            Box::new(Drift),
            Box::new(InvisibleChars),
            Box::new(PrimitiveObsession),
        ];
        v
    })
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
    fn decimal_scale_rejects_loss_of_precision() {
        // USD scale 2: 10.00 ok, 10.001 rejected.
        let usd = vec![rule("decimal", json!({ "scale": 2, "currency": "USD" }), "bad_money")];
        assert!(validate_value("decimal", &[], "balance", &usd, &json!("10.00"), &no_row()).is_ok());
        assert!(validate_value("decimal", &[], "balance", &usd, &json!("10"), &no_row()).is_ok());
        assert!(!validate_value("decimal", &[], "balance", &usd, &json!("10.001"), &no_row()).is_ok());
        // XOF scale 0 (CFA franc, no subunit): 1.5 rejected, 2 ok.
        let xof = vec![rule("decimal", json!({ "scale": 0, "currency": "XOF" }), "bad_money")];
        assert!(!validate_value("decimal", &[], "balance", &xof, &json!("1.5"), &no_row()).is_ok());
        assert!(validate_value("decimal", &[], "balance", &xof, &json!("2"), &no_row()).is_ok());
    }

    #[test]
    fn decimal_currency_must_be_iso4217_shaped() {
        let bad = vec![rule("decimal", json!({ "scale": 2, "currency": "dollars" }), "x")];
        let out = validate_value("decimal", &[], "balance", &bad, &json!("1.00"), &no_row());
        assert_eq!(out.errors[0].rule_code, "invalid_rule");
    }

    #[test]
    fn pattern_matches_and_rejects() {
        // a social handle: @ + 3-15 lowercase/digits/underscore.
        let r = vec![rule("pattern", json!({ "pattern": "^@[a-z0-9_]{3,15}$" }), "bad_handle")];
        assert!(validate_value("string", &[], "handle", &r, &json!("@redpash"), &no_row()).is_ok());
        assert!(!validate_value("string", &[], "handle", &r, &json!("nope!"), &no_row()).is_ok());
        // a malformed regex is an authoring error, not a value fail.
        let bad = vec![rule("pattern", json!({ "pattern": "([" }), "x")];
        let out = validate_value("string", &[], "handle", &bad, &json!("a"), &no_row());
        assert_eq!(out.errors[0].rule_code, "invalid_rule");
    }

    #[test]
    fn tier2_coercion_loss_warns_but_does_not_block() {
        // the zip case: "07920" passes the int codec but loses its leading zero.
        let out = validate_value("int", &[], "zip", &[], &json!("07920"), &no_row());
        assert!(out.is_ok(), "Tier-2 never blocks — the write saves");
        assert_eq!(out.warnings.len(), 1);
        assert_eq!(out.warnings[0].detector, "coercion_loss");
        assert!(out.confidence < 1.0, "confidence docked: {}", out.confidence);
        // a plain int with no leading zero → clean, full confidence.
        let clean = validate_value("int", &[], "count", &[], &json!("42"), &no_row());
        assert!(clean.warnings.is_empty() && clean.confidence == 1.0);
    }

    #[test]
    fn tier2_drift_flags_date_in_string_field() {
        let out = validate_value("string", &[], "note", &[], &json!("2026-01-13"), &no_row());
        assert_eq!(out.warnings.iter().filter(|s| s.detector == "drift").count(), 1);
        assert!(out.is_ok());
        // ordinary text → no drift.
        assert!(validate_value("string", &[], "note", &[], &json!("hello world"), &no_row()).warnings.is_empty());
    }

    // ── redteam batch #1 (Gemini/Copilot 2026-06-01): the 4 real bugs found ──
    #[test]
    fn redteam2_new_detectors() {
        // bool case-loss "TRUE" → coercion_loss
        let o = validate_value("boolean", &[], "active", &[], &json!("TRUE"), &no_row());
        assert!(o.is_ok() && o.warnings.iter().any(|w| w.detector == "coercion_loss"));
        // invisible zero-width space → invisible_chars
        let o = validate_value("string", &[], "u", &[], &json!("\u{200B}admin"), &no_row());
        assert!(o.warnings.iter().any(|w| w.detector == "invisible_chars"));
        // ZWJ emoji must NOT trip invisible_chars (legit in emoji)
        let o = validate_value("string", &[], "u", &[], &json!("👨‍👩‍👧‍👦"), &no_row());
        assert!(!o.warnings.iter().any(|w| w.detector == "invisible_chars"));
        // JSON in a string field → primitive_obsession
        let o = validate_value("string", &[], "notes", &[], &json!("{\"a\":1}"), &no_row());
        assert!(o.warnings.iter().any(|w| w.detector == "primitive_obsession"));
        // base64 in a string field → primitive_obsession
        let o = validate_value("string", &[], "payload", &[], &json!("SGVsbG8gV29ybGQ="), &no_row());
        assert!(o.warnings.iter().any(|w| w.detector == "primitive_obsession"));
        // plain text → nothing
        let o = validate_value("string", &[], "notes", &[], &json!("hello there"), &no_row());
        assert!(o.warnings.is_empty());
    }

    #[test]
    fn redteam_whitespace_coercion_warns() {
        // " \n 42 \t" passes int but loses its whitespace on store → Tier-2 warn.
        let out = validate_value("int", &[], "id", &[], &json!(" \n 42 \t"), &no_row());
        assert!(out.is_ok());
        assert!(out.warnings.iter().any(|w| w.detector == "coercion_loss"), "whitespace loss must warn");
    }

    #[test]
    fn redteam_decimal_trailing_zeros_not_loss() {
        // "10.500" is mathematically scale-2 (trailing zeros are cosmetic) → no false reject.
        let r = vec![rule("decimal", json!({ "scale": 2 }), "scale2")];
        assert!(validate_value("decimal", &[], "price", &r, &json!("10.500"), &no_row()).is_ok());
        // "10.001" is genuinely scale-3 → still rejects.
        assert!(!validate_value("decimal", &[], "price", &r, &json!("10.001"), &no_row()).is_ok());
    }

    #[test]
    fn redteam_expression_runs_on_null() {
        // a null value still evaluates a (null-aware) expression rule.
        let r = vec![rule("expression", json!({ "expr": "val == 'null'" }), "is_null_str")];
        // null == 'null' (string) → false → reject (the expression runs despite null).
        let out = validate_value("string", &[], "val", &r, &Value::Null, &no_row());
        assert_eq!(out.errors.iter().filter(|e| e.rule_code == "is_null_str").count(), 1);
        // but a SHAPE rule (range) is still skipped on null.
        let r2 = vec![rule("range", json!({ "min": 1 }), "min1")];
        assert!(validate_value("int", &[], "x", &r2, &Value::Null, &no_row()).is_ok());
    }

    #[test]
    fn redteam_nan_rejected_by_range() {
        let r = vec![rule("range", json!({ "min": 0, "max": 100 }), "ratio")];
        assert!(!validate_value("float", &[], "ratio", &r, &json!("NaN"), &no_row()).is_ok(),
            "NaN must not slip a finite range");
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
