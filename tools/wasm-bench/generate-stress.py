#!/usr/bin/env python3
"""
Generate the high-density stress CSV for the WASM Phase C bench harness.

Fourth sibling. Same schema as `generate-type-truth.py` so the answer-key
methodology is directly comparable, but cranked density:

    type-truth-100k:    1000 traps in 100,000 rows =   1% density
    stress-5k:          2000 traps in   5,000 rows =  40% density   ← 40× denser

The single open question this probes: **does the dtype counter
under-count once inference is under sustained noise pressure?**
At 1% density (type-truth) the first 4999 rows are pristine — inference
gets a quiet warm-up and locks in a clean type per column before noise
arrives. At 40% density with only 99 warm-up rows, inference has to
hold its inferred type while ~40% of every column's cells are lying.

Design:

    - 5000 rows, 5 typed cols (id/is_active/score/category/date_joined)
    - First 99 rows are 100% clean (TRAP_START=100, tight warm-up)
    - Exactly 2000 trap rows after that, distributed 500 each across
      4 typed columns:
        - 500 int_trap   — float inside the int (id) column
        - 500 bool_trap  — `maybe` inside the bool (is_active) column
        - 500 float_trap — `NaN_or_Text` inside the float (score) column
        - 500 date_trap  — `Not_A_Date` inside the date (date_joined) column

**Expected verdict:** `parse_csv` should report **exactly 2000** type
mismatches. Three possible outcomes:

    reported == 2000  →  counter is robust at high density
    reported  < 2000  →  under-counting (the suspicion from tricky-100k)
    reported  = 0     →  inference gave up — every column fell back to
                         string, so there's no inferred type to violate.
                         This is itself a finding: at what density does
                         inference collapse?

**Deterministic** — same SEED yields the same bytes. File is small
(~190 KB) so iteration is cheap.

Output:    tools/wasm-bench/corpus/stress-<N>k.csv  (gitignored)
Size:      ~190 KB at N=5k

Usage:
    python3 tools/wasm-bench/generate-stress.py            # default 5k
    python3 tools/wasm-bench/generate-stress.py 10000      # 10k variant
"""

import random
import sys
from pathlib import Path

ROOT       = Path(__file__).resolve().parent
CORPUS_DIR = ROOT / "corpus"
SEED       = 20260526
TRAP_COUNT = 2000
TRAP_START = 100   # tight warm-up — inference gets only 99 quiet rows

HEADERS = "id,is_active,score,category,date_joined\n"


def main(num_rows: int) -> None:
    random.seed(SEED)
    CORPUS_DIR.mkdir(parents=True, exist_ok=True)

    if num_rows < TRAP_START + TRAP_COUNT:
        raise SystemExit(
            f"num_rows={num_rows} too small — need >= {TRAP_START + TRAP_COUNT} "
            f"to fit {TRAP_COUNT} traps starting at row {TRAP_START}"
        )

    suffix = f"{num_rows // 1000}k" if num_rows >= 1000 else str(num_rows)
    out = CORPUS_DIR / f"stress-{suffix}.csv"

    mismatch_indices = set(random.sample(range(TRAP_START, num_rows + 1), TRAP_COUNT))
    per_trap = TRAP_COUNT // 4
    trap_types = (
        ["int_trap"]   * per_trap +
        ["bool_trap"]  * per_trap +
        ["float_trap"] * per_trap +
        ["date_trap"]  * per_trap
    )
    random.shuffle(trap_types)
    trap_map = dict(zip(mismatch_indices, trap_types))

    density_pct = 100.0 * TRAP_COUNT / num_rows
    print(f"Generating {num_rows:,} rows → {out}")
    print(f"  seed = {SEED}, trap density = {density_pct:.1f}%")
    print(f"Answer Key: parse_csv should detect EXACTLY {TRAP_COUNT} type mismatches.")
    print(f"  - {per_trap} Integer violations")
    print(f"  - {per_trap} Boolean violations")
    print(f"  - {per_trap} Float violations")
    print(f"  - {per_trap} Date violations")

    with out.open("w", encoding="utf-8") as f:
        f.write(HEADERS)
        for i in range(1, num_rows + 1):
            is_active   = random.choice(["true", "false"])
            score       = f"{random.uniform(10.0, 99.9):.2f}"
            category    = f"Category_{random.choice(['A', 'B', 'C'])}"
            date_joined = f"2026-05-{random.randint(10, 28)}"

            trap = trap_map.get(i)
            if trap == "int_trap":
                f.write(f"{i}.5,{is_active},{score},{category},{date_joined}\n")
            elif trap == "bool_trap":
                f.write(f"{i},maybe,{score},{category},{date_joined}\n")
            elif trap == "float_trap":
                f.write(f"{i},{is_active},NaN_or_Text,{category},{date_joined}\n")
            elif trap == "date_trap":
                f.write(f"{i},{is_active},{score},{category},Not_A_Date\n")
            else:
                f.write(f"{i},{is_active},{score},{category},{date_joined}\n")

    size_kb = out.stat().st_size / 1024
    print(f"Done — {size_kb:.1f} KB.")


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 5_000
    main(n)
