---
title: backend/crates/api/src/validate_expr.rs
source: ../../../../../backend/crates/api/src/validate_expr.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-06-01
---

# validate_expr.rs

## Purpose

The **cross-field expression DSL** behind `expression` ValidateRules (spec §v2,
`CAS_C7AEBE83`) — a tiny, sandboxed, deterministic *boolean* evaluator:
`amount > 0`, `from_account != to_account`,
`sold_at == null || sold_at >= listed_at`.

**Hand-rolled, zero deps** (Em 2026-06-01) — deliberately not CEL/`cel-rs`. The
`codec_avro.rs` recursion-bomb lesson is why: an external evaluator with
unbounded recursion is an *uncatchable* DoS (a Rust stack overflow aborts the
process, not a catchable panic). This evaluator is **bounded by construction**:
the parser caps depth (`MAX_EXPR_DEPTH=32`) + token count (`MAX_TOKENS=256`)
*before* eval, so the AST depth is provably small and the recursive-descent
evaluator's stack can't blow — a `((((…))))` bomb fails at parse, never reaching
eval.

Sandboxed + deterministic: inputs are only the parsed AST + the row's field map.
No I/O, clock, or RNG (so the FE can pre-evaluate the same rule and get the
backend's answer). **No function calls, no arithmetic, no loops** — arithmetic is
absent on purpose, so overflow / divide-by-zero / money-precision never enter the
DSL (those belong to the decimal rule).

## Grammar

```
or      := and ('||' and)*
and     := not ('&&' not)*
not     := '!' not | cmp
cmp     := primary (('=='|'!='|'<'|'<='|'>'|'>=') primary)?
primary := '(' or ')' | number | string | true | false | null | <field>
```
`&&` binds tighter than `||`. Field names are bare identifiers resolved against
the row; `true`/`false`/`null` are keyword literals.

## Null / type truth table (LOCKED — spec §v2)

- `x == null` / `x != null` test null explicitly — the only way null is truthy.
- any ORDERED compare (`< <= > >=`) where either side is null ⇒ **false**.
- `==` / `!=`: both coerce to numbers ⇒ numeric compare (`"5" == 5` is true);
  else compare string forms; null ≠ non-null.
- ORDERED compare across incompatible types (string vs non-numeric) ⇒ **false**
  (deterministic — a type-mismatch *smell* is a Tier-2 detector's job, not a
  hard 400 from here).

This table is reversal-expensive (changing it silently re-grades every authored
expression). It lives here, in the spec, and as labelled rows in the validation
calibration harness.

## Public surface

- `pub fn evaluate(expr: &str, row: &Row) -> Result<bool, String>` — parse +
  eval. `Ok(true/false)` = verdict; `Err` = authoring error (bad syntax /
  non-boolean result / depth-or-token bomb).
- `pub fn r_expression(_v, params, row) -> RuleCheck` — the registry rule check.
  `params.expr` is the DSL string; reads sibling fields from `row` (which
  includes the field under validation). Bad `expr` ⇒ `Malformed` (authoring bug),
  distinct from a value `Fail`.

## Drift-prone areas

- **The two bounds (`MAX_EXPR_DEPTH`, `MAX_TOKENS`) are the safety property** —
  don't remove them or make the parser iterative-without-a-cap. They're the
  field-level analog of `codec_avro`'s `MAX_JSON_DEPTH`/input cap.
- **No arithmetic** is intentional. If a rule ever needs `a + b`, that's a money
  concern → the decimal rule / a future arithmetic spike, NOT this DSL (adding
  arithmetic reintroduces overflow + float-precision questions).
- Parsing is per-call in v2 (expressions are tiny + bounded); a parse cache keyed
  on the expr string is a later optimization, not correctness.

## Related

- [validate_rules.rs](validate_rules.md) — registers `expression`; owns `Row`/`Params`/`RuleCheck`.
- [codec_avro.rs](codec_avro.md) — the recursion-bomb DoS guard this mirrors.
- [specs/type-definition](../../../specs/type-definition.md) — the §v2 contract + truth table.
