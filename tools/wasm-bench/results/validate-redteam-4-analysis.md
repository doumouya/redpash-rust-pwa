# Field-validation red-team batch #4 — analysis (for Copilot/Gemini)

**Run:** 2026-06-01 · 20 cases (61–80) vs `POST /api/demo/validate`.
**Result:** **1 build** (the `non_blank` Tier-1 rule you proposed), and your
contradiction-detector probes **all already pass** — the guards held. The rest
match or are documented holds. All 20 are permanent rows (suite `redteam_4`).
**Full gate: 100/100** (20 base + 80 adversarial across 4 rounds).

## 🆕 `non_blank` — the Tier-1 rule (61–63)

You called it last round: an all-invisible string deserves a hard reject, but
that's a *rule*, not a detector (Tier-2 never blocks). Built `non_blank`:
- **61 `null`** → valid. It's a *shape* rule (clears on null), NOT `required`. A
  missing string isn't a "blank string". (You flagged the conflation risk — avoided.)
- **62 `"\n\t\r\n"`** → reject. Length > 0 but zero visible content → blank.
- **63 `"<div></div>"`** → valid. Visible chars present; validation doesn't parse HTML.

`non_blank` strips whitespace + zero-width + invisible chars; empty remainder →
reject. It's the hard-reject pair of the `invisible_chars` Tier-2 detector.

## ✅ Your contradiction-detectors — all already handled

- **64 markdown hard-break `Line 1  \nLine 2`** → valid. The whitespace
  `coercion_loss` is **boundary-only** (`raw != raw.trim()` strips ends only), so
  interior trailing spaces (the markdown `<br>` syntax) don't trip it. No FP.
- **65 `"  3.14159…  "`** → `float_precision_loss` fires (+ `coercion_loss` for the
  surrounding ws). The float detector **trims before parsing**, so whitespace
  doesn't abort it. Both warnings stack (conf 0.5).
- **66 `" ​ "`** → `invisible_chars` fires. Detectors run on the **raw** value
  (nothing trims between them), so the ZWSP isn't eaten before `invisible_chars`
  sees it. (Also all-invisible → conf 0.0.)

## ✅ DSL combinatorial / null-matrix — all match

67 (short-circuit `missing==null || missing>5` → no panic on `null>5`), 68
(`id != 'gold'` → true), 69 (`1=='1' && '1'==true` → true && false → reject —
type-lock holds transitively), 70 (De Morgan over nulls), 75 (`missing != 5 &&
missing != 'test'` → negation flips the null matrix → true), 79 (datetimes
string-compare in the DSL: `Z != +00:00` → reject), 78 (`"null"` JSON →
Value::Null, reserializes clean), 71 (rid codec is shape-only), 73 (dup enum
options handled), 76 (huge scale 256 is a digit-count compare — no allocation,
no crash), 80 (3-detector stack clamps at conf 0, no underflow panic).

## 🤝 Holds (our contract, on purpose)

- **72 rid-pattern in string** → valid (no warn). DISAGREE: a generic
  `^[a-z]{3}_…$` heuristic is too FP-prone (it'd dock legit `"abc_123"`,
  `"foo_bar"`). We won't *guess* that a string should've been a `rid`. (Detecting
  our exact rid shape — `[A-Z]{3,4}_` + 32 hex — would be zero-FP but niche;
  deferred unless it earns its keep.)
- **74 `".50"`** → reject (`data_type`). Symmetric with batch-2's `"10."` reject:
  our decimal wire requires a leading digit (`0.50`), no implicit `.50`→`0.50`
  coercion. Explicit > implicit.
- **77 `"Hello&#x200B;World"`** → valid. Consistent with batch-3's `&zwj;`:
  validation checks **raw** bytes; HTML-entity expansion (`&#x200B;` → U+200B) is
  a **render-layer** concern (JS owns pixels). The stored bytes are literal text.

## The 4-round arc

100/100 across 80 adversarial cases from two LLMs. Each round, the *shape* never
changed — only registry entries (rules + detectors) got added or tuned:
- R1: 4 *lies* fixed (one-line, single-mechanism).
- R2: 3 detectors (coverage).
- R3: heuristic FP/FN + stacking + the float loophole.
- R4: the `non_blank` Tier-1 rule; every contradiction-probe already green.

The validator is now genuinely exhausted as an attack surface at this layer.
A `batch #5` would most usefully target the **next layer** — the custom-object
PATCH endpoint (the pipeline's real production consumer) once it lands, where
multi-field writes + RBAC + the validator combine.
