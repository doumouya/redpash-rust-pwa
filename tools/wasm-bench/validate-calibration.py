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

SUITES = {"correctness": CORRECTNESS, "taste": TASTE}

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
