---
title: backend/crates/api/src/validate_rules.rs
source: ../../../../../backend/crates/api/src/validate_rules.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-06-01
---

# validate_rules.rs

## Purpose

The **field-validation pipeline** + the open **rule registry** (TypeDefinition
spec §v2, `CAS_C7AEBE83`). Two tiers, mirroring the cleanness scorer's
`value_quality × structural` model in [structure.rs](../data/structure.md):

- **Tier 1 — hard contract gate** → `errors[]`; non-empty ⇒ HTTP 400.
  - Gate 1a: `data_type` codec shape — delegates to
    [codec_registry](codec_registry.md), **short-circuits** (a wrong-shape value
    can't meaningfully run range/length).
  - Gate 1b: each `ValidateRule` resolved against this registry — **collect-all**
    (the FE shows every broken constraint at once, like `StructureFlags` collects
    all reasons).
- **Tier 2 — soft suspicion layer** → `warnings[]` + `confidence`; never blocks.
  An open `FieldDetector` registry (the field-level twin of `StructureFlags`)
  runs on every shape-valid non-null value, even when Tier 1 passed — a value can
  satisfy the contract and still smell wrong. Seed detectors: **`coercion_loss`**
  (raw-vs-parsed — `"07920"` typed int loses its leading zero; the proven
  general detector, ported from `structure.rs`) and **`drift`** (a date-looking
  value in a `string` field, reusing `data::dtype::classify_cell`). A new
  detector is one struct + one slot in `detectors()`, zero pipeline edits.

Rule `kind` is an **OPEN string** resolved against the registry — never a closed
`match` (the same open-ended contract as `data_type`/codecs). A new rule kind is
one `register()` line, zero pipeline edits. This is the structural answer to
"edge cases we haven't thought of yet": the mechanism is general, so an unknown
constraint becomes a registered rule (Tier 1) or detector (Tier 2), and a future
Copilot/Gemini challenge becomes a new labelled row in
[validate-calibration.py](../../../tools/audit-suite/validate-calibration.md),
not a redesign.

## Public surface

- `pub fn validate_value(data_type, options, field_key, rules, value, row) ->
  FieldOutcome` — the pipeline. `row` carries sibling field values for
  cross-field rules. A JSON `null` clears the field (nullability is `required`'s
  job) → no rules run.
- `pub struct FieldOutcome { errors: Vec<RuleViolation>, warnings: Vec<Suspicion>,
  confidence: f32 }` — `is_ok()` = `errors.is_empty()`. `confidence = 1 − (Σ
  warning weight).min(1)` (the `StructureFlags::penalty()` algebra, inverted).
- `pub struct RuleViolation { field, rule_code, message }` → the 400 body.
- `pub struct Suspicion { field, detector, reason, weight }` → Tier-2 warning.
- `pub struct Rule { kind, check: fn(&Value, &Params, &Row) -> RuleCheck }` +
  `RuleRegistry` (`register` / `get` / `kinds` / `with_builtins`) + `registry()`
  OnceLock — mirrors `CodecRegistry`.
- `enum RuleCheck { Pass, Fail, Malformed(String) }` — `Malformed` flags a bad
  rule AUTHORING (e.g. `range` with a non-numeric `min`) distinct from a value
  Fail.

## Builtin rules (phase 2)

- `range { min?, max? }` — numeric bounds (inclusive); value read from a JSON
  number or numeric string.
- `length { min?, max? }` — Unicode char count of the string form.
- `enum_subset { values: [..] }` — value ∈ values (narrows an already-typed
  field per vertical).
- `expression { expr }` — cross-field boolean DSL ([validate_expr](validate_expr.md)).
- `decimal { scale?, currency? }` — the money contract (reborn `CAS_AE8F3F2D` as
  an OPEN param, not a fixed type). Enforces **scale**: more fractional digits
  than `scale` is a hard Fail (XOF `scale:0` rejects `1.5`; USD `scale:2` rejects
  `1.999`) — loss-of-precision rejected, never silently truncated. `currency` is
  an opaque ISO-4217 string (3 uppercase letters — never an enum, so any currency
  works); it rides for FE formatting + messages. Reuses
  `codec_registry::is_decimal_str` for the shape check.
- `pattern { pattern: "<regex>" }` — string value must match. Uses the `regex`
  crate (RE2-style **linear-time** matching — no ReDoS, the reason it's the safe
  choice over a hand-rolled backtracker; `regex` was already in-tree via Polars,
  promoted to a direct dep 2026-06-01). Two prevent-don't-recover bounds: the
  pattern source is length-capped (512) and the compiled program is
  `size_limit`-capped (1 MiB), so a giant authored pattern can't blow memory. A
  bad regex is `Malformed` (authoring bug), not a value `Fail`.

## Drift-prone areas

- **Tier-1 short-circuits at the codec gate; rules collect-all.** Keep that
  asymmetry — a shape failure makes downstream rules meaningless, but multiple
  broken constraints should all surface.
- **`kind` is open.** Never replace the registry lookup with a `match` — that
  reintroduces the closed-enum debt the whole §v2 design avoids.
- **Decoupled from `FieldDef`** — the pipeline takes the pieces (`data_type`,
  `options`, `rules`) not the whole struct, so it's testable without building a
  TypeDefinition and the endpoint extracts them.

## Related

- [codec_registry.rs](codec_registry.md) — Gate 1a (the pattern this mirrors).
- [field_validate.rs](field_validate.md) — the codec-shape delegate + `FieldError`.
- [structure.rs](../data/structure.md) — the file-level two-tier model this ports.
- [specs/type-definition](../../../specs/type-definition.md) — the §v2 contract.
