# Field-validation red-team batch #1 — analysis (for Copilot/Gemini)

**Run:** 2026-06-01 · 20 adversarial cases vs `POST /api/demo/validate` (TypeDefinition v2).
**Result:** 4 real bugs found + fixed; 11 matched; 5 are principled disagreements
(our contract differs from your assumption, on purpose). All 20 are now permanent
rows in `validate-calibration.py` (suite `redteam_1`). Full gate: **40/40**.

Great batch — exactly the boundary-pushing the two-tier model needs. Thank you.

## 🐛 4 real bugs you found (fixed)

| # | case | bug | fix |
|---|------|-----|-----|
| 03 | `" \n 42 \t"` int | Tier-2 `coercion_loss` **trimmed before comparing** → blind to whitespace loss. Read 1.0 confidence on dirty data. | compare the canonical int to the **untrimmed** raw — now catches leading-zero **and** sign **and** surrounding whitespace. |
| 04 | `"10.500"` scale 2 | decimal rule counted **literal** fractional digits (3) → **false-rejected** a value that's mathematically scale-2. | strip trailing zeros before the scale count — `10.500`→`10.5` (1 sig digit) passes; `10.001` still rejects. |
| 14 | `null == 'null'` | a null value **short-circuited ALL rules** → a cross-field `expression` never ran → silent pass. | shape rules (range/length/pattern/decimal/enum_subset) still clear on null, but **`expression` rules now run on null** (they're null-aware by design). `null != 'null'` → reject. |
| 15 | `"NaN"` range 0–100 | `NaN < 0` and `NaN > 100` are both false → **NaN slipped every bound** → valid. | `range` rejects non-finite (NaN / ±Inf) up front. |

Each is now a regression row + a Rust unit test. This is the whole point: your
case became a permanent guard, not a one-off patch.

## ✅ 11 matched (behaved exactly as you predicted)

01 (null `!(age<18)` → valid), 05 (ZWJ emoji → reject by char-count), 08 (missing
field → null → valid), 09 (RE2 `^/$` are text boundaries → reject), 11 (octal
`0755` → coercion warn), 12 (`"gold" > 5` → safe false → reject), 13 (`&&` tighter
than `||` → valid), 17 (negative-length rule → 0 passes), 18 (4 parens under the
depth cap → valid), 19 (`qty == '010'` numeric-coerces → valid), **20 (ReDoS
`(a+)+b` → rejected INSTANTLY — RE2 linear-time confirmed, no backtracking).**

## 🤝 5 principled disagreements (our contract, on purpose)

These aren't bugs — they're places our design deliberately differs. Pushback:

- **02 `1 < val < 3`** → we reject as **malformed** (`invalid_rule`), not a
  left-to-right mis-eval. Chained comparison isn't in the grammar; rejecting the
  *expression* is safer than silently evaluating `(1<val)<3`. Your intent (catch
  the chain) is met — just via an authoring error, not a value verdict.
- **06 `true == 'true'`** → **valid**. A boolean compares to a string by its
  *word form* (`true`↔`"true"`), so `flag == 'true'` works as a truthiness check —
  forgiving + useful for a rule author. (`true == 1` is still false: bool matches
  its word, not its number.)
- **07 JPY scale 2** → **valid**. We treat `currency` as an **opaque ISO-4217
  string** — no hardcoded currency→scale table (that closed enum is exactly the
  debt the open-registry design avoids). The author declared scale 2; we honor it.
  JPY-is-zero-decimal is the author's knowledge, not ours to enforce. *(A future
  opt-in Tier-2 detector with a loadable currency table could WARN — never block.)*
- **10 max-safe-int `9007199254740995`** → **valid**, no warn. We're **Rust**, not
  JS: `serde_json` keeps it an exact `i64` (it fits), so nothing mutates on store.
  The IEEE-754 rounding you assume is a JS-engine artifact our backend doesn't
  have. (A value > `i64::MAX` *is* rejected by the int codec.)
- **16 `"1.5e1"` decimal** → **reject (`data_type`)**. The decimal wire contract is
  plain `[+-]?digits[.digits]` — scientific notation isn't accepted (money in
  exponent form is itself a smell). Defensible contract, not a miss.

## Where to aim batch #2

The two unbuilt edges you haven't hit yet:
1. **Tier-2 confidence calibration** — we only have 2 detectors (`coercion_loss`
   w=0.3, `drift` w=0.1). Probe whether confidence *magnitudes* match severity,
   and find smells with NO detector (e.g. a float silently losing precision, a
   string that's secretly base64/JSON, a date in a non-ISO format).
2. **Cross-field expressions at depth** — multi-field rules referencing 3+ fields,
   self-referential-looking exprs, and the null/missing-field matrix across them.

Drop batch #2 as `(name, request_json, expected, why)`; we wire it straight in.
Current gate 40/40 — break it again.
