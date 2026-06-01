#!/usr/bin/env python3
"""Field-validation calibration: one regression gate, two intents, for
POST /api/demo/validate (the TypeDefinition §v2 two-tier validator).

The field-level twin of score-calibration.py. Each case is a validation request
labelled with the outcome it DESERVES; the runner checks the scorer against it.
Two suites run together as ONE gate:
  • CORRECTNESS — Tier-1 contract. HARD: a value either passes, or rejects with
    a specific rule_code. Guards what the rules+codecs+DSL enforce. A regression
    here fails the gate. (the "is it correct?" half)
  • TASTE       — Tier-2 judgment. A value that PASSES the contract but smells
    wrong (raw-vs-parsed coercion loss, drift) → a warning from a named detector,
    never a block. (the "does it feel right?" half — wide, Copilot/Gemini-authored)

A future Copilot/Gemini field-validation challenge is a NEW LABELLED CASE here,
not a redesign — same promise as score-calibration.py.

expected ∈ { "valid", "reject:<rule_code>", "warn:<detector>" }
Usage:  python3 tools/wasm-bench/validate-calibration.py [base_url] [suite]
        base_url default http://127.0.0.1:8099 ; suite default "all"
"""
import json, sys, urllib.request, urllib.error

BASE = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].startswith("http") else "http://127.0.0.1:8099"
ONLY = next((a for a in sys.argv[1:] if not a.startswith("http")), "all")
URL = BASE + "/api/demo/validate"

def rule(kind, code, message, **params):
    return {"kind": kind, "params": params, "code": code, "message": message}

# (name, request_body, expected, why)
CORRECTNESS = [
    # ── RealEstateListing acceptance (spec §v2 disposability gate) ──
    ("clean int (no rules)",
     {"data_type": "int", "field": "n", "value": 250000}, "valid",
     "well-formed int, no rules"),
    ("list_price range min 1 — zero",
     {"data_type": "int", "field": "list_price", "value": 0,
      "rules": [rule("range", "price_min", "list_price must be > 0", min=1)]},
     "reject:price_min", "0 < min 1"),
    ("list_price range min 1 — ok",
     {"data_type": "int", "field": "list_price", "value": 250000,
      "rules": [rule("range", "price_min", "list_price must be > 0", min=1)]},
     "valid", "250000 ≥ 1"),
    ("description length max 5000 — too long",
     {"data_type": "string", "field": "description", "value": "x" * 5001,
      "rules": [rule("length", "desc_len", "description too long", max=5000)]},
     "reject:desc_len", "5001 > 5000"),
    ("description length max 5000 — ok",
     {"data_type": "string", "field": "description", "value": "a tidy listing",
      "rules": [rule("length", "desc_len", "description too long", max=5000)]},
     "valid", "short text"),
    ("cross-field sold_at >= listed_at — earlier",
     {"data_type": "datetime", "field": "sold_at", "value": "2025-01-01T00:00:00Z",
      "row": {"listed_at": "2026-01-01T00:00:00Z"},
      "rules": [rule("expression", "sold_order", "sold_at must be >= listed_at",
                     expr="sold_at == null || sold_at >= listed_at")]},
     "reject:sold_order", "sold before listed"),
    ("cross-field sold_at — unset (null) ok",
     {"data_type": "datetime", "field": "sold_at", "value": None,
      "row": {"listed_at": "2026-01-01T00:00:00Z"},
      "rules": [rule("expression", "sold_order", "sold_at must be >= listed_at",
                     expr="sold_at == null || sold_at >= listed_at")]},
     "valid", "null clears + the expr allows null explicitly"),
    ("cross-field sold_at — later ok",
     {"data_type": "datetime", "field": "sold_at", "value": "2026-06-01T00:00:00Z",
      "row": {"listed_at": "2026-01-01T00:00:00Z"},
      "rules": [rule("expression", "sold_order", "sold_at must be >= listed_at",
                     expr="sold_at == null || sold_at >= listed_at")]},
     "valid", "sold after listed"),

    # ── BankingAccount cross-vertical bar (same machinery, money) ──
    ("amount range min 0.01 — zero",
     {"data_type": "decimal", "field": "amount", "value": "0.00",
      "rules": [rule("range", "amount_min", "amount must be > 0", min=0.01)]},
     "reject:amount_min", "0 < 0.01"),
    ("balance decimal XOF scale 0 — rejects subunit",
     {"data_type": "decimal", "field": "balance", "value": "1.5",
      "rules": [rule("decimal", "xof_scale", "XOF has no subunit", scale=0, currency="XOF")]},
     "reject:xof_scale", "1.5 has 1 frac digit > scale 0"),
    ("balance decimal XOF scale 0 — whole ok",
     {"data_type": "decimal", "field": "balance", "value": "2",
      "rules": [rule("decimal", "xof_scale", "XOF has no subunit", scale=0, currency="XOF")]},
     "valid", "no fractional digits"),
    ("balance decimal USD scale 2 — over-precise",
     {"data_type": "decimal", "field": "balance", "value": "10.001",
      "rules": [rule("decimal", "usd_scale", "USD has 2 decimals", scale=2, currency="USD")]},
     "reject:usd_scale", "3 frac digits > scale 2"),

    # ── codec gate + enum_subset ──
    ("int codec rejects non-numeric",
     {"data_type": "int", "field": "n", "value": "abc"}, "reject:data_type",
     "shape gate before rules"),
    ("enum_subset — not a member",
     {"data_type": "string", "field": "status", "value": "pending",
      "rules": [rule("enum_subset", "bad_status", "unknown status", values=["open", "closed"])]},
     "reject:bad_status", "pending ∉ {open,closed}"),
    ("pattern — social handle ok",
     {"data_type": "string", "field": "handle", "value": "@redpash",
      "rules": [rule("pattern", "bad_handle", "bad handle", pattern="^@[a-z0-9_]{3,15}$")]},
     "valid", "matches the handle regex"),
    ("pattern — social handle bad",
     {"data_type": "string", "field": "handle", "value": "Nope!",
      "rules": [rule("pattern", "bad_handle", "bad handle", pattern="^@[a-z0-9_]{3,15}$")]},
     "reject:bad_handle", "fails the handle regex"),
]

TASTE = [
    # Tier-2: passes the contract, but smells wrong → warn (never blocks).
    ("zip int with leading zero",
     {"data_type": "int", "field": "zip", "value": "07920"}, "warn:coercion_loss",
     "'07920' saves as int 7920 — leading zero lost. The unknown-smell catch."),
    ("plain int — no smell",
     {"data_type": "int", "field": "count", "value": "42"}, "valid",
     "no coercion loss → full confidence"),
    ("date stored in a string field",
     {"data_type": "string", "field": "note", "value": "2026-01-13"}, "warn:drift",
     "looks like a date but typed string"),
    ("ordinary text — no drift",
     {"data_type": "string", "field": "note", "value": "hello world"}, "valid",
     "genuine text"),
]

# ── Gemini/Copilot adversarial batch #1 (2026-06-01) ──
# 20 boundary-pushers. 4 found real bugs (now fixed: whitespace coercion, decimal
# trailing-zeros false-reject, expression-on-null, NaN range bypass). The rest
# match or are principled disagreements (documented in
# results/validate-redteam-1-analysis.md) where expected reflects OUR contract.
REDTEAM_1 = [
    ("01 null inversion !(age<18)",
     {"data_type": "int", "field": "age", "value": None,
      "rules": [rule("expression", "adult", "must be adult", expr="!(age < 18)")]},
     "valid", "null<18 is false; !(false)=true; also expression runs on null now"),
    ("02 chained compare 1<val<3",
     {"data_type": "int", "field": "val", "value": 2,
      "rules": [rule("expression", "chain", "out of range", expr="1 < val < 3")]},
     "reject:invalid_rule", "chained compare is rejected as MALFORMED (safer than left-to-right)"),
    ("03 whitespace coercion",
     {"data_type": "int", "field": "id", "value": " \n 42 \t"}, "warn:coercion_loss",
     "BUG FIXED: whitespace lost on store now warns"),
    ("04 decimal trailing zeros 10.500/scale2",
     {"data_type": "decimal", "field": "price", "value": "10.500",
      "rules": [rule("decimal", "scale2", "scale 2", scale=2)]},
     "valid", "BUG FIXED: trailing zeros are cosmetic, not precision loss"),
    ("05 emoji ZWJ length",
     {"data_type": "string", "field": "bio", "value": "👨‍👩‍👧‍👦!",
      "rules": [rule("length", "len5", "too long", max=5)]},
     "reject:len5", "char-count (not grapheme) — documented tradeoff"),
    ("06 bool == 'true' string",
     {"data_type": "boolean", "field": "flag", "value": True,
      "rules": [rule("expression", "is_true_str", "x", expr="flag == 'true'")]},
     "valid", "DISAGREE: bool compares by word-form to strings (forgiving + useful)"),
    ("07 JPY scale 2 (opaque currency)",
     {"data_type": "decimal", "field": "amt", "value": 500.50,
      "rules": [rule("decimal", "jpy_scale", "x", scale=2, currency="JPY")]},
     "valid", "DISAGREE: currency is opaque (no ISO-4217 scale table — open-ended by design)"),
    ("08 missing row field == null",
     {"data_type": "int", "field": "count", "value": 10, "row": {"other_field": 5},
      "rules": [rule("expression", "check_null", "x", expr="missing_field == null")]},
     "valid", "unresolved field → null; null==null true"),
    ("09 multiline anchor bypass",
     {"data_type": "string", "field": "code", "value": "ABC\n123",
      "rules": [rule("pattern", "alpha", "x", pattern="^[A-Z]+$")]},
     "reject:alpha", "RE2 ^/$ are text boundaries (not per-line) → no match → reject"),
    ("10 max-safe-int (Rust i64 exact)",
     {"data_type": "int", "field": "id", "value": 9007199254740995,
      "rules": [rule("range", "min0", "x", min=0)]},
     "valid", "DISAGREE: Rust serde_json keeps i64 exact — no JS float mutation, no loss"),
    ("11 octal-looking 0755",
     {"data_type": "int", "field": "perms", "value": "0755"}, "warn:coercion_loss",
     "leading zero lost on store → warn"),
    ("12 string > number safety",
     {"data_type": "string", "field": "tier", "value": "gold",
      "rules": [rule("expression", "gt5", "x", expr="tier > 5")]},
     "reject:gt5", "cross-type ordered compare → false → reject, no crash"),
    ("13 precedence true||true&&false",
     {"data_type": "boolean", "field": "pass", "value": True,
      "rules": [rule("expression", "prec", "x", expr="true || true && false")]},
     "valid", "&& binds tighter than || → true"),
    ("14 null == 'null' string",
     {"data_type": "string", "field": "val", "value": None,
      "rules": [rule("expression", "is_null_str", "x", expr="val == 'null'")]},
     "reject:is_null_str", "BUG FIXED: expression runs on null; null != 'null' string → reject"),
    ("15 NaN range poisoning",
     {"data_type": "float", "field": "ratio", "value": "NaN",
      "rules": [rule("range", "valid_ratio", "x", min=0, max=100)]},
     "reject:valid_ratio", "BUG FIXED: range rejects non-finite (NaN slipped all bounds)"),
    ("16 scientific notation 1.5e1",
     {"data_type": "decimal", "field": "amount", "value": "1.5e1",
      "rules": [rule("decimal", "noscale", "x", scale=0)]},
     "reject:data_type", "DISAGREE: decimal wire is plain notation; scientific rejected by codec"),
    ("17 negative length min -5",
     {"data_type": "string", "field": "name", "value": "",
      "rules": [rule("length", "neg_len", "x", min=-5)]},
     "valid", "0 >= -5 passes (rule self-validation not enforced; harmless)"),
    ("18 nested parens depth 4",
     {"data_type": "boolean", "field": "x", "value": True,
      "rules": [rule("expression", "deep", "x", expr="((((x == true))))")]},
     "valid", "4 parens well under the depth-32 cap"),
    ("19 numeric coercion qty == '010'",
     {"data_type": "int", "field": "qty", "value": 10,
      "rules": [rule("expression", "eq_str", "x", expr="qty == '010'")]},
     "valid", "==/!= coerce numeric-first: '010'→10, 10==10 true"),
    ("20 ReDoS probe (a+)+b",
     {"data_type": "string", "field": "txt", "value": "a" * 28 + "c",
      "rules": [rule("pattern", "redos", "x", pattern="(a+)+b")]},
     "reject:redos", "RE2 linear-time: rejects instantly, no catastrophic backtracking"),
]

# ── Gemini/Copilot adversarial batch #2 (2026-06-01) ──
# 20 more: null-matrix, nested expressions, and a heavy push on Tier-2 breadth.
# Drove 3 new detectors (coercion_loss→bool, invisible_chars, primitive_obsession);
# the rest match or are principled holds (see results/validate-redteam-2-analysis.md).
REDTEAM_2 = [
    ("21 paradoxical null bounds", {"data_type": "int", "field": "a", "value": 10,
      "rules": [rule("expression", "null_trap", "x", expr="!(a < b) && !(a >= b)")]},
     "valid", "missing b=null; both ordered compares false; negations both true"),
    ("22 three-way missing equality", {"data_type": "boolean", "field": "x", "value": True,
      "rules": [rule("expression", "deep_null", "x", expr="x == (y == z)")]},
     "valid", "null==null=true; true==true=true (nested expr bubbles up)"),
    ("23 missing vs explicit null", {"data_type": "string", "field": "a", "value": "test",
      "row": {"explicit_c": None},
      "rules": [rule("expression", "null_eq", "x", expr="missing_b == explicit_c")]},
     "valid", "missing field and explicit null both resolve to the null token"),
    ("24 f64 extreme precision", {"data_type": "float", "field": "m",
      "value": 3.1415926535897932384626433}, "valid",
     "LIMITATION: float loss is invisible post-serde-parse; the answer is data_type decimal (wire-as-string)"),
    ("25 json whitespace normalize", {"data_type": "json", "field": "config",
      "value": "{ \"key\" :   \"value\" }"}, "valid",
     "DISAGREE: JSON whitespace normalization is desirable, not loss"),
    ("26 string secretly JSON", {"data_type": "string", "field": "notes",
      "value": "{\"user_id\": 42, \"role\": \"admin\"}"}, "warn:primitive_obsession",
     "NEW DETECTOR: JSON hidden in a string field"),
    ("27 string secretly base64", {"data_type": "string", "field": "payload",
      "value": "SGVsbG8gV29ybGQ="}, "warn:primitive_obsession",
     "NEW DETECTOR: base64 in a string field"),
    ("28 self-referential NaN", {"data_type": "float", "field": "ratio", "value": "NaN",
      "rules": [rule("expression", "eq_self", "x", expr="ratio == ratio")]},
     "reject:eq_self", "DSL inherits IEEE NaN != NaN → false → reject"),
    ("29 bool word case-loss", {"data_type": "boolean", "field": "is_active", "value": "TRUE"},
     "warn:coercion_loss", "NEW: 'TRUE' normalizes to 'true' → case lost"),
    ("30 decimal trailing point", {"data_type": "decimal", "field": "amount", "value": "10."},
     "reject:data_type", "HOLD: '10.' is malformed (empty fractional) → codec rejects"),
    ("31 negative zero", {"data_type": "decimal", "field": "balance", "value": "-0",
      "rules": [rule("decimal", "scale0", "x", scale=0)]},
     "valid", "HOLD: -0 fits scale 0; sign-on-zero loss too niche to flag"),
    ("32 datetime tz +00:00", {"data_type": "datetime", "field": "created_at",
      "value": "2026-06-01T12:00:00+00:00"}, "valid",
     "DISAGREE: the validator doesn't normalize datetimes (no reserialize, no loss)"),
    ("33 cross-type eq numeric-wins", {"data_type": "int", "field": "id", "value": 123,
      "row": {"str_id": "123"}, "rules": [rule("expression", "cross_eq", "x", expr="id == str_id")]},
     "valid", "== coerces numeric-first: 123 == '123' → true"),
    ("34 zero-width space", {"data_type": "string", "field": "username", "value": "​admin"},
     "warn:invisible_chars", "NEW DETECTOR: zero-width / invisible chars"),
    ("35 datetime non-ISO", {"data_type": "datetime", "field": "start",
      "value": "2026/06/01 12:00:00"}, "reject:data_type",
     "HOLD: strict RFC3339 — non-ISO rejected (no lenient parse + silent reformat)"),
    ("36 deep unparen precedence", {"data_type": "boolean", "field": "a", "value": False,
      "row": {"b": True, "c": False, "d": True, "e": True},
      "rules": [rule("expression", "prec_depth", "x", expr="a || b && c || d && e")]},
     "valid", "&& binds tighter: false||(true&&false)||(true&&true) → true"),
    ("37 empty enum options", {"data_type": "enum", "options": [], "field": "status",
      "value": "active"}, "reject:data_type",
     "empty options → codec rejects (value ∉ {}); caught, not silent"),
    ("38 string 'null' trap", {"data_type": "string", "field": "state", "value": "null",
      "rules": [rule("expression", "not_null", "x", expr="state != null")]},
     "valid", "literal string 'null' is not the null token → != null is true"),
    ("39 int vs bool cross-field", {"data_type": "int", "field": "count", "value": 1,
      "row": {"bool_val": True}, "rules": [rule("expression", "int_bool", "x", expr="count == bool_val")]},
     "reject:int_bool", "1 == true → false (bool matches word not number) → reject"),
    ("40 multiline expression", {"data_type": "boolean", "field": "flag", "value": True,
      "rules": [rule("expression", "format", "x", expr="\n  flag \n  == \n  true \n")]},
     "valid", "newlines are whitespace to the lexer"),
]

# ── Gemini/Copilot adversarial batch #3 (2026-06-01) — heuristic FP/FN, ──
# confidence stacking, the string-typed-float loophole. Drove JWT detection,
# boundary-ZWJ, float_precision_loss, decimal/string coercion, all-invisible
# weight=1.0. See results/validate-redteam-3-analysis.md.
JWT = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
       "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ")
REDTEAM_3 = [
    ("41 base64 FP password", {"data_type": "string", "field": "password", "value": "Super/Secret+Password="},
     "valid", "len%4!=0 (22) → not flagged; FP-averse guard protects passwords"),
    ("42 base64 FN unpadded", {"data_type": "string", "field": "payload", "value": "SGVsbG8gV29ybGQg"},
     "valid", "DISAGREE: clean base64 w/o +/= is a deliberate FN (bias FP-averse over passwords/words)"),
    ("43 base64url JWT", {"data_type": "string", "field": "token", "value": JWT},
     "warn:primitive_obsession", "NEW: JWT detection (dotted base64url, header decodes to {alg})"),
    ("44 solo trailing ZWJ", {"data_type": "string", "field": "username", "value": "admin‍"},
     "warn:invisible_chars", "NEW: boundary ZWJ flagged (joins nothing) — closes the bypass; interior ZWJ still ok"),
    ("45 string-typed float precision", {"data_type": "string", "field": "exact_val", "value": "3.1415926535897932384626433"},
     "warn:float_precision_loss", "NEW: the loophole — string carries raw digits; >17 sig → f64 loss"),
    ("46 decimal leading zeros 007.50", {"data_type": "decimal", "field": "money", "value": "007.50",
      "rules": [rule("decimal", "s2", "x", scale=2)]},
     "warn:coercion_loss", "NEW: decimal int-part leading zeros lost"),
    ("47 stack: json + invisible", {"data_type": "string", "field": "config", "value": "{\"key\": \"​value\"}"},
     "warn:invisible_chars", "primitive_obsession(0.2)+invisible(0.3) → conf 0.5; invisible present"),
    ("48 all-invisible string", {"data_type": "string", "field": "name", "value": "​​​",
      "rules": [rule("length", "not_empty", "x", min=1)]},
     "warn:invisible_chars", "DISAGREE on Tier-1 reject (never-blocks invariant); weight→1.0, conf 0; use a non_blank rule"),
    ("49 empty json object", {"data_type": "string", "field": "data", "value": "{}"},
     "warn:primitive_obsession", "empty {} is still JSON-in-a-string"),
    ("50 cross-field f64 equal", {"data_type": "float", "field": "f_val", "value": 0.1,
      "row": {"s_val": "0.10000000000000001"}, "rules": [rule("expression", "eq", "x", expr="f_val == s_val")]},
     "valid", "both coerce to the same f64 → equal"),
    ("51 dsl scientific coercion", {"data_type": "int", "field": "qty", "value": 1000,
      "rules": [rule("expression", "eq_sci", "x", expr="qty == '1e3'")]},
     "valid", "numeric-first coercion: '1e3'→1000, 1000==1000"),
    ("52 datetime nanoseconds", {"data_type": "datetime", "field": "start", "value": "2026-06-01T12:00:00.123456789Z"},
     "valid", "DISAGREE: chrono is nanosecond-precise + we don't reserialize → no truncation in our layer"),
    ("53 markdown HTML script", {"data_type": "markdown", "field": "bio", "value": "Hello <script>alert(1)</script>"},
     "valid", "DISAGREE: sanitization is a RENDER concern (js owns pixels); the validator doesn't mutate"),
    ("54 markdown HTML entity zwj", {"data_type": "markdown", "field": "post", "value": "Title&zwj;"},
     "valid", "DISAGREE: validation checks raw chars; '&zwj;' is literal text until render"),
    ("55 enum null bypass", {"data_type": "enum", "options": ["A", "B"], "field": "status", "value": None},
     "valid", "null clears the enum subset check too (nullability is required's job)"),
    ("56 string 'true ' == true", {"data_type": "string", "field": "flag", "value": "true ",
      "rules": [rule("expression", "is_true", "x", expr="flag == true")]},
     "reject:is_true", "'true ' (space) != bool word 'true' → false → reject"),
    ("57 double-missing ordered", {"data_type": "string", "field": "a", "value": "test",
      "rules": [rule("expression", "gt_null", "x", expr="missing_a > missing_b")]},
     "reject:gt_null", "null > null → false → reject, no crash"),
    ("58 base64 FP math formula", {"data_type": "string", "field": "formula", "value": "Speed=Distance/T"},
     "valid", "mid-string '=' fails the DECODE check → not flagged (FP defeated)"),
    ("59 negative zero float", {"data_type": "float", "field": "f", "value": "-0.0",
      "rules": [rule("expression", "eq0", "x", expr="f == 0.0")]},
     "valid", "IEEE -0.0 == 0.0 is true"),
    ("60 max penalty stacking", {"data_type": "string", "field": "data", "value": " { \"key\": \"​\" } "},
     "warn:coercion_loss", "coercion(ws 0.3)+primitive(0.2)+invisible(0.3)=0.8 → conf 0.2; all three fire"),
]

# ── Gemini/Copilot adversarial batch #4 (2026-06-01) — the non_blank Tier-1 ──
# rule + contradiction-detector probes + DSL combinatorial load. 1 build
# (non_blank); the contradiction probes all already pass. See
# results/validate-redteam-4-analysis.md.
REDTEAM_4 = [
    ("61 non_blank + null", {"data_type": "string", "field": "name", "value": None,
      "rules": [rule("non_blank", "nb", "x")]},
     "valid", "NEW RULE: non_blank is a shape rule → skipped on null (≠ required)"),
    ("62 non_blank control chars", {"data_type": "string", "field": "bio", "value": "\n\t\r\n",
      "rules": [rule("non_blank", "nb", "x")]},
     "reject:nb", "NEW RULE: whitespace-only has no visible content → reject"),
    ("63 non_blank html illusion", {"data_type": "string", "field": "html", "value": "<div></div>",
      "rules": [rule("non_blank", "nb", "x")]},
     "valid", "visible chars present; validation doesn't parse HTML"),
    ("64 markdown hard-break FP", {"data_type": "markdown", "field": "comment", "value": "Line 1  \nLine 2"},
     "valid", "whitespace coercion is BOUNDARY-only → interior trailing spaces (md hard-break) don't trip"),
    ("65 float-loss strips ws first", {"data_type": "string", "field": "exact", "value": "  3.14159265358979323846  "},
     "warn:float_precision_loss", "float_precision_loss trims before parsing → fires (+ coercion_loss for the ws)"),
    ("66 invisible survives (raw)", {"data_type": "string", "field": "username", "value": " ​ "},
     "warn:invisible_chars", "detectors see the RAW value; ZWSP not eaten by any trim"),
    ("67 dsl short-circuit null", {"data_type": "int", "field": "x", "value": 1,
      "rules": [rule("expression", "sc_null", "x", expr="missing == null || missing > 5")]},
     "valid", "short-circuit + null>5 is false, no panic"),
    ("68 dsl != coercion", {"data_type": "int", "field": "id", "value": 5,
      "rules": [rule("expression", "neq_str", "x", expr="id != 'gold'")]},
     "valid", "5 != 'gold' → true"),
    ("69 triple cross-type eq", {"data_type": "int", "field": "i_val", "value": 1,
      "row": {"s_val": "1", "b_val": True},
      "rules": [rule("expression", "triple_eq", "x", expr="i_val == s_val && s_val == b_val")]},
     "reject:triple_eq", "1=='1' true; '1'==true false (bool word) → && false → reject"),
    ("70 demorgan null law", {"data_type": "string", "field": "test", "value": "test",
      "rules": [rule("expression", "demorgan", "x", expr="!(missing == 5 || missing == 'A')")]},
     "valid", "null==anything false; !(false||false)=true"),
    ("71 rid uuid", {"data_type": "rid", "field": "user_id", "value": "123e4567-e89b-12d3-a456-426614174000"},
     "valid", "rid codec is shape-only (any string)"),
    ("72 rid-pattern in string", {"data_type": "string", "field": "account_id", "value": "usr_2Tfedo93K45abc"},
     "valid", "DISAGREE: a generic prefix_alnum heuristic is too FP-prone (docks 'abc_123'); we don't guess rids"),
    ("73 enum duplicate options", {"data_type": "enum", "options": ["A", "A", "B"], "field": "status", "value": "A"},
     "valid", "contains() handles dup options fine"),
    ("74 decimal leading-point .50", {"data_type": "decimal", "field": "price", "value": ".50",
      "rules": [rule("decimal", "s2", "x", scale=2)]},
     "reject:data_type", "HOLD: '.50' has no integer part → malformed wire (symmetric with '10.' reject)"),
    ("75 dsl null inequality chain", {"data_type": "boolean", "field": "b", "value": True,
      "rules": [rule("expression", "neq_null", "x", expr="missing != 5 && missing != 'test'")]},
     "valid", "null != x is true (negation flips the null matrix)"),
    ("76 decimal huge scale 256", {"data_type": "decimal", "field": "rate", "value": "0.1",
      "rules": [rule("decimal", "huge_scale", "x", scale=256)]},
     "valid", "scale is a digit-count compare, no allocation → safe"),
    ("77 markdown hex entity", {"data_type": "markdown", "field": "post", "value": "Hello&#x200B;World"},
     "valid", "DISAGREE: '&#x200B;' is literal text; entity expansion is render-layer (consistent with &zwj;)"),
    ("78 json codec 'null'", {"data_type": "json", "field": "config", "value": "null"},
     "valid", "'null' is valid JSON → Value::Null → reserializes to 'null', no loss"),
    ("79 datetime cross-field eq", {"data_type": "datetime", "field": "t1", "value": "2026-06-01T12:00:00Z",
      "row": {"t2": "2026-06-01T12:00:00+00:00"},
      "rules": [rule("expression", "dt_eq", "x", expr="t1 == t2")]},
     "reject:dt_eq", "DSL string-compares datetimes (no chrono cast): Z != +00:00 → reject"),
    ("80 confidence floor lock", {"data_type": "string", "field": "spam", "value": " {\"key\": \"​\"} \n"},
     "warn:invisible_chars", "coercion+primitive+invisible stack → conf clamps at 0, no underflow panic"),
]

SUITES = {"correctness": CORRECTNESS, "taste": TASTE, "redteam_1": REDTEAM_1,
          "redteam_2": REDTEAM_2, "redteam_3": REDTEAM_3, "redteam_4": REDTEAM_4}

def post(body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(URL, data=data, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"_err": str(e)[:80]}

def verdict(expected, status, body):
    errs = body.get("errors", [])
    warns = body.get("warnings", [])
    if expected == "valid":
        return (status == 200 and not errs and not warns,
                f"200/clean (got {status}, {len(errs)}e {len(warns)}w)")
    if expected.startswith("reject:"):
        code = expected.split(":", 1)[1]
        hit = status == 400 and any(e.get("rule_code") == code for e in errs)
        got = ",".join(e.get("rule_code", "?") for e in errs) or "-"
        return hit, f"400/{code} (got {status}/{got})"
    if expected.startswith("warn:"):
        det = expected.split(":", 1)[1]
        hit = status == 200 and not errs and any(w.get("detector") == det for w in warns)
        got = ",".join(w.get("detector", "?") for w in warns) or "-"
        return hit, f"200/warn:{det} (got {status}/{got})"
    return False, f"unknown expected {expected!r}"

def run_suite(name, cases):
    if not cases:
        print(f"── {name}: (empty)\n"); return 0, 0
    print(f"── {name}")
    print(f"{'case':<40} {'expected':<22} {'verdict':<7} detail")
    p = m = 0
    for cname, body, expected, _why in cases:
        st, b = post(body)
        ok, detail = verdict(expected, st, b)
        conf = b.get("confidence")
        confs = f" conf={conf:.2f}" if isinstance(conf, (int, float)) else ""
        print(f"{cname:<40} {expected:<22} {'PASS' if ok else 'MISS':<7} {detail}{confs}")
        p += ok; m += (not ok)
    print(f"   {p}/{len(cases)} pass · {m} miss\n")
    return p, m

def main():
    suites = SUITES if ONLY == "all" else {ONLY: SUITES.get(ONLY, [])}
    print(f"validate-calibration — {URL}  (suite: {ONLY})\n")
    tp = tm = tn = 0
    for name, cases in suites.items():
        p, m = run_suite(name, cases)
        tp += p; tm += m; tn += len(cases)
    print(f"GATE: {tp}/{tn} pass · {tm} miss")
    sys.exit(0 if tm == 0 else 1)

if __name__ == "__main__":
    main()
