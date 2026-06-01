//! Purpose: the **cross-field expression DSL** for `expression` ValidateRules
//! (spec §v2, CAS_C7AEBE83) — a tiny, sandboxed, deterministic boolean
//! evaluator: `amount > 0`, `from_account != to_account`,
//! `sold_at == null || sold_at >= listed_at`.
//! Doc: docs/internal/code/backend/api/validate_expr.md
//!
//! HAND-ROLLED, zero deps (Em 2026-06-01) — NOT CEL/`cel-rs`. The
//! `codec_avro.rs` recursion-bomb lesson is the reason: an external evaluator
//! with unbounded recursion is an *uncatchable* DoS (a Rust stack overflow
//! aborts the process, not a catchable panic). This evaluator is
//! **non-recursive-by-construction-bounded**: the parser caps depth
//! (`MAX_EXPR_DEPTH`) + token count (`MAX_TOKENS`) BEFORE eval, so the AST depth
//! is provably small and the recursive-descent evaluator's stack can't blow. A
//! `((((…))))` bomb fails at parse time, never reaching eval.
//!
//! Sandboxed + deterministic: the only inputs are the parsed AST + the row's
//! field map. No I/O, no clock, no RNG — same inputs ⇒ same result (so the FE
//! can pre-evaluate the same rule and get the backend's answer). No function
//! calls, no arithmetic, no loops: arithmetic is deliberately absent so overflow
//! / divide-by-zero / money-precision questions never enter the DSL (those
//! belong to the decimal rule).
//!
//! ## Null / type truth table (LOCKED — spec §v2)
//! - `x == null` / `x != null` test null explicitly (the only way null is truthy).
//! - any ORDERED compare (`< <= > >=`) where either side is null ⇒ **false**.
//! - `==` / `!=`: if both sides coerce to numbers, compare numerically (so
//!   `"5" == 5`); else compare string forms; null≠non-null.
//! - ORDERED compare across incompatible types (e.g. string vs number that
//!   doesn't parse) ⇒ **false** (deterministic; a type-mismatch smell is a
//!   Tier-2 detector's job, not a hard 400 from here).
#![allow(dead_code)]

use serde_json::Value;

use crate::validate_rules::{Params, Row, RuleCheck};

/// Parse-depth cap. The AST can nest no deeper than this, so the evaluator's
/// recursion is bounded regardless of input (the codec_avro DoS guard, applied
/// to the parser). 32 is far beyond any real authored rule.
const MAX_EXPR_DEPTH: usize = 32;
/// Token cap — a second independent bound (a flat 10k-token expression is as
/// abusive as a deep one). 256 covers any real rule.
const MAX_TOKENS: usize = 256;

// ── AST (deliberately tiny — the smallness IS the safety property) ───────────

#[derive(Debug, Clone, PartialEq)]
enum CmpOp { Eq, Ne, Lt, Le, Gt, Ge }

#[derive(Debug, Clone)]
enum Expr {
    Lit(Value),                          // null | bool | number | string
    Field(String),                       // a sibling field on the row
    Cmp(Box<Expr>, CmpOp, Box<Expr>),
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    Not(Box<Expr>),
}

// ── tokenizer ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(String),   // kept as text; coerced at eval (avoids float in the AST)
    Str(String),
    Ident(String), // field name, or the keywords true/false/null
    Op(CmpOp),
    And, Or, Not,
    LParen, RParen,
}

fn tokenize(src: &str) -> Result<Vec<Tok>, String> {
    let b = src.as_bytes();
    let mut i = 0;
    let mut out = Vec::new();
    while i < b.len() {
        let c = b[i];
        if out.len() > MAX_TOKENS {
            return Err(format!("expression too long (> {MAX_TOKENS} tokens)"));
        }
        match c {
            b' ' | b'\t' | b'\n' | b'\r' => { i += 1; }
            b'(' => { out.push(Tok::LParen); i += 1; }
            b')' => { out.push(Tok::RParen); i += 1; }
            b'!' => {
                if i + 1 < b.len() && b[i + 1] == b'=' { out.push(Tok::Op(CmpOp::Ne)); i += 2; }
                else { out.push(Tok::Not); i += 1; }
            }
            b'=' => {
                if i + 1 < b.len() && b[i + 1] == b'=' { out.push(Tok::Op(CmpOp::Eq)); i += 2; }
                else { return Err("'=' must be '==' ".into()); }
            }
            b'<' => {
                if i + 1 < b.len() && b[i + 1] == b'=' { out.push(Tok::Op(CmpOp::Le)); i += 2; }
                else { out.push(Tok::Op(CmpOp::Lt)); i += 1; }
            }
            b'>' => {
                if i + 1 < b.len() && b[i + 1] == b'=' { out.push(Tok::Op(CmpOp::Ge)); i += 2; }
                else { out.push(Tok::Op(CmpOp::Gt)); i += 1; }
            }
            b'&' => {
                if i + 1 < b.len() && b[i + 1] == b'&' { out.push(Tok::And); i += 2; }
                else { return Err("'&' must be '&&'".into()); }
            }
            b'|' => {
                if i + 1 < b.len() && b[i + 1] == b'|' { out.push(Tok::Or); i += 2; }
                else { return Err("'|' must be '||'".into()); }
            }
            b'\'' | b'"' => {
                let quote = c;
                let start = i + 1;
                let mut j = start;
                while j < b.len() && b[j] != quote { j += 1; }
                if j >= b.len() { return Err("unterminated string literal".into()); }
                out.push(Tok::Str(src[start..j].to_string()));
                i = j + 1;
            }
            // negative or positive numeric literal (no binary arithmetic exists,
            // so a leading sign can only begin a number).
            b'-' | b'+' | b'0'..=b'9' => {
                let start = i;
                if c == b'-' || c == b'+' { i += 1; }
                let mut seen_dot = false;
                let mut digits = 0;
                while i < b.len() {
                    match b[i] {
                        b'0'..=b'9' => { digits += 1; i += 1; }
                        b'.' if !seen_dot => { seen_dot = true; i += 1; }
                        _ => break,
                    }
                }
                if digits == 0 { return Err("malformed number".into()); }
                out.push(Tok::Num(src[start..i].to_string()));
            }
            _ if c.is_ascii_alphabetic() || c == b'_' => {
                let start = i;
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') { i += 1; }
                out.push(Tok::Ident(src[start..i].to_string()));
            }
            _ => return Err(format!("unexpected character '{}'", c as char)),
        }
    }
    Ok(out)
}

// ── recursive-descent parser (depth-bounded) ─────────────────────────────────
// Grammar (low → high precedence):
//   or   := and ('||' and)*
//   and  := not ('&&' not)*
//   not  := '!' not | cmp
//   cmp  := primary (cmpop primary)?
//   primary := '(' or ')' | literal | field

struct Parser {
    toks: Vec<Tok>,
    pos:  usize,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> { self.toks.get(self.pos) }
    fn next(&mut self) -> Option<Tok> { let t = self.toks.get(self.pos).cloned(); if t.is_some() { self.pos += 1; } t }

    fn parse(src: &str) -> Result<Expr, String> {
        let toks = tokenize(src)?;
        if toks.is_empty() { return Err("empty expression".into()); }
        let mut p = Parser { toks, pos: 0 };
        let e = p.or_expr(0)?;
        if p.pos != p.toks.len() {
            return Err("trailing tokens after expression".into());
        }
        Ok(e)
    }

    fn depth_guard(d: usize) -> Result<(), String> {
        if d > MAX_EXPR_DEPTH { Err(format!("expression nested too deep (> {MAX_EXPR_DEPTH})")) } else { Ok(()) }
    }

    fn or_expr(&mut self, d: usize) -> Result<Expr, String> {
        Self::depth_guard(d)?;
        let mut left = self.and_expr(d + 1)?;
        while matches!(self.peek(), Some(Tok::Or)) {
            self.next();
            let right = self.and_expr(d + 1)?;
            left = Expr::Or(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn and_expr(&mut self, d: usize) -> Result<Expr, String> {
        Self::depth_guard(d)?;
        let mut left = self.not_expr(d + 1)?;
        while matches!(self.peek(), Some(Tok::And)) {
            self.next();
            let right = self.not_expr(d + 1)?;
            left = Expr::And(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn not_expr(&mut self, d: usize) -> Result<Expr, String> {
        Self::depth_guard(d)?;
        if matches!(self.peek(), Some(Tok::Not)) {
            self.next();
            return Ok(Expr::Not(Box::new(self.not_expr(d + 1)?)));
        }
        self.cmp_expr(d + 1)
    }

    fn cmp_expr(&mut self, d: usize) -> Result<Expr, String> {
        Self::depth_guard(d)?;
        let left = self.primary(d + 1)?;
        if let Some(Tok::Op(op)) = self.peek().cloned() {
            self.next();
            let right = self.primary(d + 1)?;
            return Ok(Expr::Cmp(Box::new(left), op, Box::new(right)));
        }
        Ok(left)
    }

    fn primary(&mut self, d: usize) -> Result<Expr, String> {
        Self::depth_guard(d)?;
        match self.next() {
            Some(Tok::LParen) => {
                let e = self.or_expr(d + 1)?;
                match self.next() {
                    Some(Tok::RParen) => Ok(e),
                    _ => Err("expected ')'".into()),
                }
            }
            Some(Tok::Num(s)) => {
                let n: f64 = s.parse().map_err(|_| "bad number literal".to_string())?;
                Ok(Expr::Lit(serde_json::json!(n)))
            }
            Some(Tok::Str(s)) => Ok(Expr::Lit(Value::String(s))),
            Some(Tok::Ident(name)) => Ok(match name.as_str() {
                "true"  => Expr::Lit(Value::Bool(true)),
                "false" => Expr::Lit(Value::Bool(false)),
                "null"  => Expr::Lit(Value::Null),
                _       => Expr::Field(name),
            }),
            other => Err(format!("unexpected token: {other:?}")),
        }
    }
}

// ── evaluator (deterministic; the locked truth table) ────────────────────────

fn as_num(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
}

fn str_form(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn eq(a: &Value, b: &Value) -> bool {
    match (a.is_null(), b.is_null()) {
        (true, true) => true,
        (true, false) | (false, true) => false,
        (false, false) => {
            if let (Some(x), Some(y)) = (as_num(a), as_num(b)) {
                x == y
            } else if let (Value::Bool(x), Value::Bool(y)) = (a, b) {
                x == y
            } else {
                str_form(a) == str_form(b)
            }
        }
    }
}

/// Ordered comparison. `None` ⇒ "not comparable" (null involved, or cross-type)
/// ⇒ the caller treats any ordered op as false.
fn order(a: &Value, b: &Value) -> Option<std::cmp::Ordering> {
    if a.is_null() || b.is_null() {
        return None;
    }
    if let (Some(x), Some(y)) = (as_num(a), as_num(b)) {
        return x.partial_cmp(&y);
    }
    if let (Value::String(x), Value::String(y)) = (a, b) {
        return Some(x.cmp(y));
    }
    None // cross-type ordered compare → false
}

fn to_bool(v: &Value) -> Result<bool, String> {
    match v {
        Value::Bool(b) => Ok(*b),
        Value::String(s) => match s.to_ascii_lowercase().as_str() {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(format!("expected a boolean, got string \"{s}\"")),
        },
        other => Err(format!("expected a boolean, got {other}")),
    }
}

fn eval_val(e: &Expr, row: &Row) -> Result<Value, String> {
    Ok(match e {
        Expr::Lit(v) => v.clone(),
        Expr::Field(name) => row.get(name).cloned().unwrap_or(Value::Null),
        Expr::Cmp(l, op, r) => {
            let a = eval_val(l, row)?;
            let b = eval_val(r, row)?;
            let res = match op {
                CmpOp::Eq => eq(&a, &b),
                CmpOp::Ne => !eq(&a, &b),
                CmpOp::Lt => matches!(order(&a, &b), Some(std::cmp::Ordering::Less)),
                CmpOp::Le => matches!(order(&a, &b), Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)),
                CmpOp::Gt => matches!(order(&a, &b), Some(std::cmp::Ordering::Greater)),
                CmpOp::Ge => matches!(order(&a, &b), Some(std::cmp::Ordering::Greater | std::cmp::Ordering::Equal)),
            };
            Value::Bool(res)
        }
        Expr::And(l, r) => {
            // short-circuit
            if !to_bool(&eval_val(l, row)?)? { Value::Bool(false) }
            else { Value::Bool(to_bool(&eval_val(r, row)?)?) }
        }
        Expr::Or(l, r) => {
            if to_bool(&eval_val(l, row)?)? { Value::Bool(true) }
            else { Value::Bool(to_bool(&eval_val(r, row)?)?) }
        }
        Expr::Not(x) => Value::Bool(!to_bool(&eval_val(x, row)?)?),
    })
}

/// Parse + evaluate an expression against a row. `Ok(true/false)` is the rule
/// verdict; `Err` is an authoring error (bad syntax / non-boolean result / a
/// depth-or-token-bomb). Parsing happens per call in v2 (expressions are tiny +
/// bounded); a parse cache keyed on the expr string is a later optimization.
pub fn evaluate(expr: &str, row: &Row) -> Result<bool, String> {
    let ast = Parser::parse(expr)?;
    let v = eval_val(&ast, row)?;
    to_bool(&v).map_err(|_| "expression must evaluate to a boolean".to_string())
}

/// The `expression` rule check (registered into the rule registry). `params.expr`
/// is the DSL string; it reads sibling fields from `row` (which includes the
/// field under validation). A bad `expr` is `Malformed` (an authoring bug in the
/// TypeDefinition), distinct from a value `Fail`.
pub fn r_expression(_v: &Value, params: &Params, row: &Row) -> RuleCheck {
    let Some(expr) = params.get("expr").and_then(Value::as_str) else {
        return RuleCheck::Malformed("expression rule needs params.expr: \"<dsl>\"".into());
    };
    match evaluate(expr, row) {
        Ok(true) => RuleCheck::Pass,
        Ok(false) => RuleCheck::Fail,
        Err(e) => RuleCheck::Malformed(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(pairs: &[(&str, Value)]) -> Row {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn comparisons_and_fields() {
        let r = row(&[("amount", json!(10))]);
        assert_eq!(evaluate("amount > 0", &r), Ok(true));
        assert_eq!(evaluate("amount > 100", &r), Ok(false));
        assert_eq!(evaluate("amount == 10", &r), Ok(true));
        // string-form numeric coercion (cell-editor sends strings)
        let rs = row(&[("amount", json!("10"))]);
        assert_eq!(evaluate("amount >= 10", &rs), Ok(true));
    }

    #[test]
    fn cross_field_and_or() {
        let r = row(&[("from_account", json!("A")), ("to_account", json!("B"))]);
        assert_eq!(evaluate("from_account != to_account", &r), Ok(true));
        let same = row(&[("from_account", json!("A")), ("to_account", json!("A"))]);
        assert_eq!(evaluate("from_account != to_account", &same), Ok(false));
    }

    #[test]
    fn null_truth_table() {
        // the spec's own example: null is allowed (sold_at unset) OR ordered.
        let unset = row(&[("sold_at", Value::Null), ("listed_at", json!("2026-01-01"))]);
        assert_eq!(evaluate("sold_at == null || sold_at >= listed_at", &unset), Ok(true));
        // sold_at present + earlier than listed_at → ordered branch false, null branch false → false
        let earlier = row(&[("sold_at", json!("2025-01-01")), ("listed_at", json!("2026-01-01"))]);
        assert_eq!(evaluate("sold_at == null || sold_at >= listed_at", &earlier), Ok(false));
        // sold_at present + later → true
        let later = row(&[("sold_at", json!("2026-06-01")), ("listed_at", json!("2026-01-01"))]);
        assert_eq!(evaluate("sold_at == null || sold_at >= listed_at", &later), Ok(true));
        // ordered compare with a null operand is false (not an error)
        let r = row(&[("a", Value::Null)]);
        assert_eq!(evaluate("a > 5", &r), Ok(false));
        assert_eq!(evaluate("a != null", &r), Ok(false));
    }

    #[test]
    fn cross_type_ordered_is_false_not_error() {
        let r = row(&[("a", json!("hello")), ("b", json!(5))]);
        assert_eq!(evaluate("a > b", &r), Ok(false));   // string vs number, deterministic false
        assert_eq!(evaluate("a != b", &r), Ok(true));   // != across types is true
    }

    #[test]
    fn precedence_and_parens() {
        let r = row(&[("x", json!(5))]);
        // && binds tighter than ||
        assert_eq!(evaluate("x > 0 || x > 0 && x > 100", &r), Ok(true));
        assert_eq!(evaluate("(x > 0 || x > 100) && x > 100", &r), Ok(false));
        assert_eq!(evaluate("!(x > 100)", &r), Ok(true));
    }

    #[test]
    fn depth_bomb_rejected_at_parse() {
        let bomb = "(".repeat(100) + "x > 0" + &")".repeat(100);
        let r = row(&[("x", json!(1))]);
        let res = evaluate(&bomb, &r);
        assert!(res.is_err(), "deep nesting must be rejected, got {res:?}");
        assert!(res.unwrap_err().contains("deep"));
    }

    #[test]
    fn token_bomb_rejected() {
        // a flat chain of many ORs blows the token cap
        let chain = std::iter::repeat("x > 0").take(200).collect::<Vec<_>>().join(" || ");
        let r = row(&[("x", json!(1))]);
        assert!(evaluate(&chain, &r).is_err());
    }

    #[test]
    fn malformed_and_non_boolean() {
        let r = row(&[("x", json!(5))]);
        assert!(evaluate("x >", &r).is_err());          // dangling op
        assert!(evaluate("x = 5", &r).is_err());         // single '='
        assert!(evaluate("x", &r).is_err());             // non-boolean result (bare number)
        assert!(evaluate("", &r).is_err());              // empty
    }

    #[test]
    fn rule_check_wraps_evaluate() {
        let r = row(&[("amount", json!(0))]);
        let p: Params = [("expr".to_string(), json!("amount > 0"))].into_iter().collect();
        assert!(matches!(r_expression(&Value::Null, &p, &r), RuleCheck::Fail));
        let p2: Params = [("expr".to_string(), json!("amount >= 0"))].into_iter().collect();
        assert!(matches!(r_expression(&Value::Null, &p2, &r), RuleCheck::Pass));
        let p3: Params = Params::new(); // missing expr
        assert!(matches!(r_expression(&Value::Null, &p3, &r), RuleCheck::Malformed(_)));
    }
}
