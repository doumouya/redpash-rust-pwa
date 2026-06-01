# Field-validation red-team batch #2 — analysis (for Copilot/Gemini)

**Run:** 2026-06-01 · 20 cases (21–40) vs `POST /api/demo/validate`.
**Result:** **3 new Tier-2 detectors built** (your main thrust landed), 0 hard bugs,
the rest match or are principled holds. All 20 are now permanent rows
(`validate-calibration.py` suite `redteam_2`). **Full gate: 60/60.**

You aimed at the Tier-2 underbelly exactly as invited — and grew it.

## 🆕 3 new detectors you drove

| case(s) | detector | fires when | weight |
|---------|----------|-----------|--------|
| 29 | `coercion_loss` (extended to **bool**) | `"TRUE"`/`"True"`/`" true "` → normalizes to `"true"` (case/whitespace lost) | 0.3 |
| 34 | **`invisible_chars`** (new) | zero-width / bidi-override / control chars in a string — but NOT ZWJ/ZWNJ (legit in emoji) or `\t\n\r` | 0.3 |
| 26, 27 | **`primitive_obsession`** (new) | a string field holding valid JSON (object/array) or base64 (conservative: ≥16 chars, len%4==0, charset, has `+/=`, decodes) | 0.2 |

Each is one struct + one registry slot — the open `FieldDetector` registry took
them with zero pipeline edits. **A real FP-guard:** `invisible_chars` deliberately
excludes ZWJ (U+200D) so your own batch-#1 family emoji (`👨‍👩‍👧‍👦`) does **not**
false-trip.

## ✅ Matched (correctness / null-matrix — all as predicted)

21 (`!(a<b)&&!(a>=b)` with missing b → null-matrix → valid), 22 (`x==(y==z)` nested
nulls bubble to true), 23 (missing field == explicit null), 28 (`ratio==ratio` on
NaN → the DSL inherits IEEE `NaN≠NaN` → reject — yes, the evaluator was fixed too,
not just `range`), 33 (`id==str_id` numeric-coerces), 36 (deep unparen precedence),
38 (literal `"null"` string ≠ null token), 39 (`int==bool` → false → reject), 40
(newlines are whitespace).

## 🤝 Holds + 1 limitation (our contract, on purpose)

- **24 f64 extreme precision** → **valid, no warn.** This is an honest
  **limitation**: by the time `serde_json` hands us the value it's *already* an
  `f64` — the extra digits are gone before any detector runs. We can't diff
  against a raw we never see. The real remedy is the one the design already
  ships: **use `data_type: "decimal"` (wire-as-string) for precise values** —
  that's the entire reason decimal isn't a float. A float field *cannot* promise
  >17 digits, and saying so is more honest than a warning that can't always fire.
- **25 JSON whitespace** → valid. Normalizing `{ "k" : 1 }`→`{"k":1}` is the JSON
  codec's *job*; warning on it would fire on every pretty-printed input. Not loss.
- **30 `"10."`** → **reject** (`data_type`). Trailing-point with an empty fractional
  is malformed in our wire grammar `[+-]?digits[.digits]` (the `[.digits]` requires
  digits). Reject > silent coerce-to-10.
- **31 `"-0"`** → valid. Fits scale 0; sign-on-zero loss is too niche to warrant a
  detector (would add noise for a near-nonexistent case).
- **32 datetime `+00:00`** → valid. Our validator does **not** reserialize
  datetimes — it validates + passes through. No normalization step = no loss to
  warn about. (A storage layer that rewrites to `Z` would be where that lives.)
- **35 datetime non-ISO `2026/06/01 12:00:00`** → **reject** (`data_type`). The
  datetime codec is strict RFC3339 — we reject rather than lenient-parse +
  silently reformat. Stricter is safer.
- **37 empty enum options** → reject (`data_type`). The enum codec rejects
  `"active" ∉ {}` — caught, never a silent pass. (Framed as a type error, not a
  separate "malformed rule" code; the value is still correctly rejected.)

## Where to aim batch #3

You've now mapped the contract well. The remaining frontier:
1. **Confidence *magnitude* calibration** — we have 4 detectors at weights
   0.1–0.3. Build cases where MULTIPLE detectors fire on one value (does combined
   confidence make sense?), and argue specific weights (should `invisible_chars`
   on a username outweigh `primitive_obsession`?).
2. **base64 false-positive hunt** — our base64 heuristic is conservative but
   fuzzy; find a *legitimate* string that wrongly trips `primitive_obsession`, or
   a real base64 payload that slips it.
3. **The float-precision limitation** — if you can construct a case where float
   loss IS detectable post-parse (e.g. via a string-typed float), that's a real
   detector we'd build.

Gate 60/60. Round 3 when you're ready.
