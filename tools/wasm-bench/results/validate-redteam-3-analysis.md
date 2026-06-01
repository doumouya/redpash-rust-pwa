# Field-validation red-team batch #3 — analysis (for Copilot/Gemini)

**Run:** 2026-06-01 · 20 cases (41–60) vs `POST /api/demo/validate`.
**Result:** **6 real improvements built** (incl. the string-float loophole you
were challenged to find), 2 false-positives already defeated by existing guards,
the rest match or are principled holds. All 20 are permanent rows (suite
`redteam_3`). **Full gate: 80/80.**

The deep end paid off — this batch grew Tier-2 the most of the three.

## 🆕 6 improvements you drove

| case(s) | what | detail |
|---------|------|--------|
| 43 | **JWT detection** (primitive_obsession) | dotted base64url whose header decodes to `{alg:…}` — ZERO-FP, catches the base64url case the base64 arm skips |
| 44 | **boundary ZWJ** (invisible_chars) | a LEADING/TRAILING `ZWJ`/`ZWNJ` joins nothing → flagged (closes the homoglyph bypass you found); interior ZWJ (emoji) still passes |
| 45 | **`float_precision_loss`** (new detector) | **the loophole** — a number in a STRING field still has its raw digits; >17 significant digits → warns "use decimal". (A `float` field can't be caught — serde already truncated.) |
| 46 | **decimal leading-zero** (coercion_loss) | `007.50` → `7.50`: integer-part leading zeros lost |
| 60 | **string whitespace** (coercion_loss) | surrounding whitespace on a string/markdown value → warn (interior is fine) |
| 48 | **all-invisible → weight 1.0** | a string with no visible content → confidence **0.0** |

## ✅ Your FP hunt — both already defeated (no change needed)

- **41 password `Super/Secret+Password=`** → valid. It's 22 chars; our base64 gate
  requires `len % 4 == 0`. Defeated.
- **58 `Speed=Distance/T`** → valid. Our gate requires a successful **decode**, and
  a mid-string `=` (not padding) fails it. Defeated.
- **42 unpadded base64 `SGVsbG8gV29ybGQg`** → valid (deliberate **false-negative**).
  Clean base64 without `+/=` is indistinguishable from a 16-char word; we bias
  **FP-averse** (a docked password is worse than a missed blob). JWTs — the
  common real case — are caught by their structure instead.

## 🎚️ Confidence stacking (your calibration probe) — works + clamps

- **47** json(0.2) + invisible(0.3) → **conf 0.50** ✓
- **48** all-invisible → weight **1.0** → **conf 0.00** ✓
- **60** whitespace(0.3) + json(0.2) + invisible(0.3) = 0.8 → **conf 0.20**, clamped
  safe ✓. Weights sum linearly, capped at [0,1].

## 🤝 Holds (our contract, on purpose)

- **48 all-invisible → reject?** No — Tier-2 **never blocks** (the invariant).
  Weight 1.0 (conf 0) screams; to HARD-reject, author a `non_blank` Tier-1 rule
  (a clean future rule kind). The detector shouldn't 400.
- **52 datetime nanoseconds** → valid. We use `chrono` (nanosecond-precise) and we
  **don't reserialize** datetimes in validation, so there's no truncation in our
  layer to warn about. (Microsecond truncation would be a *storage*-type concern.)
- **53 markdown `<script>`** → valid. Sanitization is a **render** concern (JS owns
  pixels); the validator must not mutate the stored value. XSS is killed at render.
- **54 markdown `&zwj;`** → valid. We check **raw** characters; `&zwj;` is literal
  text until an HTML render expands it — also a render-layer concern.

## ✅ Matched (DSL / null / coercion semantics)

49 (empty `{}` → JSON), 50 (`0.1 == "0.10000000000000001"` → same f64 → equal),
51 (`qty == '1e3'` numeric-coerces → 1000), 55 (null bypasses enum subset too),
56 (`"true "` with space ≠ bool word → reject), 57 (`null > null` → false →
reject, no crash), 59 (`-0.0 == 0.0` → true).

## Where to aim batch #4

You've now stress-tested heuristics, stacking, and the float loophole. Remaining
frontiers: (1) the `non_blank` Tier-1 rule (should an all-invisible/whitespace
string be a hard 400 when authored?) — design call; (2) detector **interaction**
bugs (a value that makes two detectors give contradictory signals); (3) the
expression DSL under combinatorial null/type/precedence load.

Gate 80/80. Round 4 when ready.
