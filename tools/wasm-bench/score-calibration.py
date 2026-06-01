#!/usr/bin/env python3
"""Score-calibration suite for /api/demo/parse.

Turns the parser fuzzing into a JUDGMENT ENGINE: ~18 CSVs each labelled with the
score band it DESERVES (a human judgment), and the runner checks the scorer
against that band. A MISS is either a lie (score too high — the cursed-≈100
class) or over-harshness (too low). Re-run while tuning data::structure penalty
weights + the cleanness scorer until everything PASSes.

Usage:  python3 tools/wasm-bench/score-calibration.py [base_url]
        (default base_url http://127.0.0.1:8099)
"""
import json, sys, urllib.request, urllib.error

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8099"
URL = BASE + "/api/demo/parse"

# (name, csv_bytes, lo, hi, why) — lo..hi is the band the file DESERVES.
CASES = [
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

def main():
    print(f"score-calibration — {URL}\n")
    print(f"{'case':<24} {'target':>8} {'score':>6} {'raw':>5}  {'verdict':<6} flags")
    passes = misses = 0
    for name, b, lo, hi, _why in CASES:
        d = parse(b)
        if "score" not in d:
            print(f"{name:<24} {f'{lo}-{hi}':>8} {'ERR':>6}        {d}")
            misses += 1
            continue
        sc = round(d["score"], 1)
        raw = round(d.get("score_raw", d["score"]), 1)
        st = d.get("structure", {})
        flags = ",".join(k.replace("_suspect", "") for k in
                         ("line_ending_suspect","binary_suspect","delimiter_suspect",
                          "ragged_suspect","header_suspect") if st.get(k)) or "-"
        if lo <= sc <= hi:
            verdict, ok = "PASS", True
        elif sc > hi:
            verdict, ok = "HIGH↑", False   # lying — scores better than it deserves
        else:
            verdict, ok = "LOW↓", False    # too harsh
        passes += ok; misses += (not ok)
        print(f"{name:<24} {f'{lo}-{hi}':>8} {sc:>6} {raw:>5}  {verdict:<6} {flags}")
    print(f"\n{passes}/{len(CASES)} within band · {misses} miss")
    sys.exit(0 if misses == 0 else 1)

if __name__ == "__main__":
    main()
