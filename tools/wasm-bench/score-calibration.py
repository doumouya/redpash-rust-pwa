#!/usr/bin/env python3
"""Score-calibration: one regression gate, two intents, for /api/demo/parse.

Turns parser fuzzing into a JUDGMENT ENGINE: each CSV is labelled with the score
band it DESERVES, and the runner checks the scorer against that band. A MISS is
either a lie (score too high — the cursed-≈100 class) or over-harshness (too low).

Two suites run together as ONE gate (`SUITES` below):
  • `adversarial` — correctness / lie-proofing. HARD bands (the cursed cases
    must drop). These guard what rounds 1–3 locked; a taste-tuning weight change
    that regresses one of these FAILS the gate. Don't widen these bands to win.
  • `taste`       — judgment / "voice". WIDE bands (±~15) on representative
    real-world-messy data, where the right score is a matter of seasoned
    judgment, not correctness. Authored by the adversary LLMs (Copilot/Gemini)
    — drop a batch in as `("name", b"…", lo, hi, "why")` tuples; no code change.

Tune `data::structure` penalty weights + the cleanness scorer until both PASS.

Usage:  python3 tools/wasm-bench/score-calibration.py [base_url] [suite]
        base_url default http://127.0.0.1:8099 ; suite default "all"
        (pass a suite name to run just that one)
"""
import json, sys, urllib.request, urllib.error

BASE = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].startswith("http") else "http://127.0.0.1:8099"
ONLY = next((a for a in sys.argv[1:] if not a.startswith("http")), "all")
URL = BASE + "/api/demo/parse"

# (name, csv_bytes, lo, hi, why) — lo..hi is the band the file DESERVES.
ADVERSARIAL = [
    # ── clean (90–100) ──
    ("clean typed table", b"id,name,age\n1,Alice,30\n2,Bob,41\n3,Carl,29\n", 90, 100,
     "well-formed, typed, no nulls"),
    ("clean + a few nulls", b"id,name,city\n1,Alice,Paris\n2,Bob,\n3,Carl,Rome\n", 80, 100,
     "one empty cell is normal"),
    ("clean semicolon file", b"id;name;age\n1;Alice;30\n2;Bob;41\n", 88, 100,
     "consistent ; delimiter — sniff should handle, not penalize"),
    ("clean quoted multiline", b'id,note\n1,"line one\nline two"\n2,"plain"\n', 85, 100,
     "embedded newline in a quoted field is legit"),

    # ── minor issues (65–90) ──
    ("one type-drift column", b"id,amount\n1,10\n2,20\n3,foo\n4,40\n", 65, 88,
     "mostly-numeric col with one string — should sting a bit (hook #6)"),
    ("leading-zero ids", b"id,code\n1,001\n2,010\n3,100\n", 70, 92,
     "leading zeros may be normalized away — mild"),
    ("duplicate headers", b"id,name,id,name\n1,Alice,10,foo\n2,Bob,20,bar\n", 60, 82,
     "dup header names — labels wrong, data fine"),
    ("all-numeric headers", b"123,456,789\n1,2,3\n4,5,6\n", 60, 85,
     "a data row likely used as the header"),
    ("boolean soup", b"id,active\n1,yes\n2,no\n3,1\n4,true\n5,N\n", 60, 85,
     "mixed boolean encodings — type ambiguity"),

    # ── moderate (40–70) ──
    ("ragged rows", b"a,b,c\n1,2,3\n4\n5,6,7,8,9,10\n", 40, 68,
     "field counts vary wildly — truncation/shape risk"),
    ("CR-only line endings", b"id,name\r1,Alice\r2,Bob\r3,Carl", 50, 75,
     "parses now, but classic-Mac is a smell"),
    ("european decimals", b"id,price\n1,1.234,56\n2,2.000,00\n3,3.500,75\n", 45, 72,
     "EU decimal/grouping mis-splits under comma delim"),
    ("high empty %", b"a,b,c,d\n1,,,\n2,,x,\n,,,\n4,,,\n", 30, 60,
     "mostly-empty grid — low information"),

    # ── bad / cursed (0–40) ──
    ("mixed-delim header", b"id;name,age|city\n1;Alice,30|London\n2;Bob,|Paris\n", 15, 55,
     "ambiguous shape — schema lie risk"),
    ("invalid UTF-8", b"id,value\n1,ok\n2,bad\xe2\xe2\n", 0, 40,
     "binary masquerading as text"),
    ("control chars", b"id,value\n1,ok\n2,\x00\x07\x1b\x7f\n", 0, 40,
     "NUL/BEL/ESC in cells — round-trip corruption"),
    ("sparse single cell", b",,,,\n,,,,\n,,42,,\n,,,,\n", 5, 40,
     "one value in an empty grid"),
    ("structureless blob", b"x\nasdkjfh3984hg\n\xff\xfe garbage\n", 0, 45,
     "no real tabular structure"),
]

# ── taste / "voice" suite — representative real-world-messy data where the
# right score is a matter of judgment, not correctness. WIDE bands (±~15) on
# purpose: this calibrates how the scorer FEELS, and false precision here just
# creates churn. To be authored by the adversary LLMs (Copilot/Gemini); drop
# tuples in below, same shape as ADVERSARIAL. Empty until that batch lands —
# the gate skips an empty suite so the harness is green in the meantime.
TASTE = [
    # Copilot taste-shaping batch #1 (2026-06-01). Bands are Copilot's; the
    # "axis" in the why says which weight a miss points at. Cases that probe
    # binary / BOM / line-endings use REAL bytes (Copilot wrote them as prose).
    ("1 one-value typo", b"id,name,age,city\n1,Alice,30,London\n2,Bob,29,Paris\n3,Charlie,31,Berlin\n4,Dave,300,London\n5,Eve,28,Madrid\n", 92, 100,
     "axis: outlier-value tolerance — age=300 is valid int, shouldn't ding"),
    ("2 clean but tiny", b"id,value\n1,foo\n2,bar\n3,baz\n", 90, 100,
     "axis: small-N — 3 rows, structurally perfect"),
    ("3 mostly-numeric + junk", b"id,amount\n1,10\n2,20\n3,thirty\n4,40\n5,?\n6,60\n", 70, 88,
     "axis: type-drift severity (hook #6) + sentinel"),
    ("4 mixed date formats", b"id,date\n1,2026-01-13\n2,13/01/2026\n3,01/13/2026\n4,2026/01/13\n5,2026-01-14\n", 70, 88,
     "axis: date-format drift — all parse, only 2/5 strict-ISO"),
    ("5 boolean soup", b"id,active\n1,yes\n2,no\n3,1\n4,0\n5,true\n6,false\n7,Y\n8,N\n9,TRUE\n10,FALSE\n", 75, 90,
     "axis: bool-encoding tolerance — salvageable, not corrupt"),
    ("6 sparse but usable", b"id,name,age,city\n1,Alice,30,London\n2,,29,Paris\n3,Charlie,,Berlin\n4,Dave,31,\n5,,,Madrid\n", 55, 75,
     "axis: completeness weight — usable table with holes"),
    ("7 numeric headers", b"123,456,789\n1,2,3\n4,5,6\n7,8,9\n", 70, 88,
     "axis: header penalty — data clean, labels are a data row"),
    ("8 duplicate headers", b"id,name,id,name\n1,Alice,10,foo\n2,Bob,20,bar\n3,Charlie,30,baz\n", 65, 85,
     "axis: header penalty — dup names, rows fine"),
    ("9 leading-zero ids", b"id,code\n1,001\n2,010\n3,100\n4,007\n5,0001\n", 70, 92,
     "axis: numeric-id-loss penalty"),
    ("10 ; with quoted commas", b'id;name;note\n1;Alice;"likes, commas"\n2;Bob;"plain text"\n3;Charlie;"another, note"\n4;Delta;"no commas"\n', 75, 90,
     "axis: delimiter — stray commas are quoted, file is clean ;"),
    ("11 whitespace-only rows", b"id,name,age\n1,Alice,30\n\n2,Bob,29\n  \n3,Charlie,31\n\n4,Delta,32\n", 60, 80,
     "axis: blank/whitespace-row handling"),
    ("12 locale numeric ambiguity", b'id,price\n1,1.234,56\n2,1,234.56\n3,1234,56\n4,1234.56\n5,"1,234.56"\n6,"1.234,56"\n', 50, 75,
     "axis: locale-decimal ambiguity (EU vs US in one col)"),
    ("13 one ragged (extra col)", b"id,name,age\n1,Alice,30\n2,Bob,29\n3,Charlie,31,extra\n4,Delta,32\n", 65, 85,
     "axis: single-row over-width truncation"),
    ("14 one short row", b"id,name,age\n1,Alice,30\n2,Bob,\n3,Charlie,31\n4,Delta,32\n", 70, 90,
     "axis: single missing value (null, not shape)"),
    ("15 control chars in cell", b'id,comment\n1,"all good"\n2,"has NUL \x00 inside"\n3,"has ESC \x1b here"\n4,"normal again"\n', 55, 75,
     "axis: binary penalty severity — 1 ctrl byte vs whole-file garbage"),
    ("16 mixed CRLF/LF no lone CR", b"id,name,age\r\n1,Alice,30\r\n2,Bob,29\n3,Charlie,31\r\n4,Delta,32\n", 80, 95,
     "axis: line-ending penalty — mixed but no data loss"),
    ("17 very sparse, 1 real row", b"id,name,age\n,,,\n2,Bob,29\n,,,\n,,,\n", 10, 40,
     "axis: completeness floor — mostly empty, not zero"),
    ("18 wide consistent (20 col)", b"c1,c2,c3,c4,c5,c6,c7,c8,c9,c10,c11,c12,c13,c14,c15,c16,c17,c18,c19,c20\n1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20\n21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40\n", 85, 100,
     "axis: wide-but-consistent — many cols shouldn't scare it"),
    ("19 one wrong-type row", b"id,amount\n1,10\n2,20\n3,thirty\n4,40\n5,50\n", 70, 90,
     "axis: type-drift severity — 1 string in numeric col"),
    ("20 BOM + comment 1st line", b"\xef\xbb\xbf# generated by some tool\nid,name,age\n1,Alice,30\n2,Bob,29\n3,Charlie,31\n", 75, 92,
     "axis: preamble/BOM header detection"),
]

# All suites run together as ONE gate. Add a suite here and it joins the gate.
SUITES = {
    "adversarial": ADVERSARIAL,
    "taste": TASTE,
}

# structure flags, in report order — keep in sync with StructureFlags.
FLAG_KEYS = ("line_ending_suspect", "binary_suspect", "delimiter_suspect",
             "ragged_suspect", "header_suspect", "type_drift_suspect",
             "numeric_id_loss_suspect")

def parse(b):
    req = urllib.request.Request(URL, data=b, method="POST",
                                 headers={"Content-Type": "text/csv"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {"_http": e.code}
    except Exception as e:
        return {"_err": str(e)[:80]}

def run_suite(name, cases):
    if not cases:
        print(f"── {name}: (empty — no cases yet)\n")
        return 0, 0
    print(f"── {name}")
    print(f"{'case':<26} {'target':>8} {'score':>6} {'raw':>5}  {'verdict':<6} flags")
    passes = misses = 0
    for cname, b, lo, hi, _why in cases:
        d = parse(b)
        if "score" not in d:
            print(f"{cname:<26} {f'{lo}-{hi}':>8} {'ERR':>6}        {d}")
            misses += 1
            continue
        sc = round(d["score"], 1)
        raw = round(d.get("score_raw", d["score"]), 1)
        st = d.get("structure", {})
        flags = ",".join(k.replace("_suspect", "") for k in FLAG_KEYS if st.get(k)) or "-"
        if lo <= sc <= hi:
            verdict, ok = "PASS", True
        elif sc > hi:
            verdict, ok = "HIGH↑", False   # lying — scores better than it deserves
        else:
            verdict, ok = "LOW↓", False    # too harsh
        passes += ok; misses += (not ok)
        print(f"{cname:<26} {f'{lo}-{hi}':>8} {sc:>6} {raw:>5}  {verdict:<6} {flags}")
    print(f"   {passes}/{len(cases)} within band · {misses} miss\n")
    return passes, misses

def main():
    suites = SUITES if ONLY == "all" else {ONLY: SUITES.get(ONLY, [])}
    print(f"score-calibration — {URL}  (suite: {ONLY})\n")
    total_pass = total_miss = total_n = 0
    for name, cases in suites.items():
        p, m = run_suite(name, cases)
        total_pass += p; total_miss += m; total_n += len(cases)
    print(f"GATE: {total_pass}/{total_n} within band · {total_miss} miss")
    sys.exit(0 if total_miss == 0 else 1)

if __name__ == "__main__":
    main()
