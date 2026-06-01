# Adversarial prompt — attack RedPash field validation (`POST /api/demo/validate`)

**Paste this to Copilot / Gemini.** You're red-teaming a brand-new field-validation
engine (TypeDefinition v2). The CSV parser already survived your earlier suites;
this is its field-level sibling. **The goal is not "make it crash" — it's to make
it LIE**: accept a value it shouldn't, reject a value it should accept, or report
a confidence that doesn't match how wrong the value is. Crashes/hangs are bonus
findings.

## The endpoint

`POST /api/demo/validate` — stateless, no auth, in-memory. Request JSON:

```json
{
  "data_type": "int",                 // codec id: string|int|float|boolean|enum|datetime|json|rid|markdown|decimal
  "options": ["open","closed"],       // only for the "enum" codec
  "field": "amount",                  // field key (used in messages + as the expression's own row slot)
  "rules": [                          // the §v2 ValidateRule[] — see kinds below
    { "kind":"range", "params":{"min":1}, "code":"min1", "message":"must be >= 1" }
  ],
  "value": 0,                         // the value under test
  "row": { "listed_at":"2026-01-01T00:00:00Z" }   // sibling fields for cross-field expressions
}
```

Response — a **two-tier** outcome:
```json
// 200 — Tier-1 passed. May carry Tier-2 warnings + a confidence in [0,1].
{ "errors":[], "warnings":[{"field":"zip","detector":"coercion_loss","reason":"…","weight":0.3}], "confidence":0.7 }
// 400 — a Tier-1 hard violation.
{ "errors":[{"field":"amount","rule_code":"min1","message":"…"}], "warnings":[], "confidence":1.0 }
```

- **Tier 1 (hard, 400):** the `data_type` codec shape, then every `ValidateRule`.
- **Tier 2 (soft, never blocks):** a value can pass the contract and still be
  flagged (`coercion_loss`, `drift`) with a docked `confidence`. A 200 with a
  warning is *intended* — not a bug. A 200 with **no** warning on data that
  clearly smells **is** a finding.

## The rule kinds to attack

| kind | params | rejects when |
|------|--------|--------------|
| `range` | `min?`, `max?` | numeric value out of bounds |
| `length` | `min?`, `max?` | Unicode char count out of bounds |
| `enum_subset` | `values:[..]` | value ∉ values |
| `pattern` | `pattern:"<regex>"` | string fails the regex (RE2 linear-time; source ≤512, compiled ≤1 MiB) |
| `decimal` | `scale?`, `currency?` | more fractional digits than `scale` (XOF scale 0 rejects `1.5`); bad ISO-4217 → malformed |
| `expression` | `expr:"<dsl>"` | the cross-field boolean DSL is false |

## The expression DSL (the richest attack surface)

Grammar: `==,!=,<,<=,>,>=,&&,||,!`, parens, field refs, literals (number /
`'string'` / `true` / `false` / `null`). No functions, no arithmetic. Bounded:
parse depth ≤32, ≤256 tokens (deeper/longer → authoring error, not a crash).
**Locked null/type truth table** (probe these hard):
- `x == null` / `x != null` test null explicitly.
- ordered compare (`< <= > >=`) with a null operand ⇒ **false**.
- `==`/`!=` coerce numeric-then-string; null ≠ non-null.
- ordered compare across incompatible types ⇒ **false**.

## Where to aim (the unknowns we want you to find)

1. **DSL semantics:** `null` interactions, `"5" == 5` coercion, `true == 1`,
   chained compares (`a < b < c` — is it even valid?), operator precedence
   surprises, unicode/whitespace in field names, a field ref that isn't in `row`,
   deeply nested or pathologically long expressions, `!` on a non-boolean.
2. **decimal/money:** scientific notation (`1e3`), `+`/`-` signs, leading/trailing
   zeros vs scale, `"10."` / `".5"`, huge magnitudes, `scale` larger than the
   value, weird/lowercase currency, currency without scale.
3. **Coercion (Tier-2):** values that lose data on store but DON'T warn — leading
   zeros on non-int types, `"10.50"` precision, reformatted dates, `" 42 "` with
   whitespace, `"1_000"`, full-width digits, `"0x1F"`.
4. **range/length:** floats vs ints, NaN/Infinity, negative lengths, multi-byte
   chars vs combining marks (is `length` counting what a human would?), emoji.
5. **pattern:** a pattern that's valid but matches nothing/everything; anchoring
   (`^$`) gaps; a pattern probing for ReDoS (we claim linear-time — try to break
   that claim); unicode classes.
6. **Cross-tier consistency:** a value that's both a Tier-1 pass AND should
   Tier-2 warn — does the confidence make sense? Is a 0.9 ever assigned to
   something that deserves 0.3?

## How to submit

Give us ~20 cases as `(name, request_json, expected, why)` where `expected` is one
of `"valid"`, `"reject:<rule_code>"`, `"warn:<detector>"`. We drop them straight
into `tools/wasm-bench/validate-calibration.py` (CORRECTNESS for hard contract
cases, TASTE for judgment/warning cases) — a permanent regression row each.
Current gate: **20/20**. Break it.
