#!/usr/bin/env python3
"""
Generate the known-truth type-mismatch CSV for the WASM Phase C bench harness.

Third sibling to `generate.py` (clean steady-state) and
`generate-tricky.py` (chaos at scale). This one is purpose-built to
answer one question: **does the dtype inference report under-count?**

Design:

    - 99% clean rows establish the schema (5 cols: id/bool/score/category/date)
    - Exactly 1000 trap rows, distributed 250 each across 4 typed
      columns:
        - 250 int_trap   — float inside the int (id) column
        - 250 bool_trap  — `maybe` inside the bool (is_active) column
        - 250 float_trap — `NaN_or_Text` inside the float (score) column
        - 250 date_trap  — `Not_A_Date` inside the date (date_joined) column
    - Traps only land at row 5000+, so the first 4999 rows let dtype
      inference converge cleanly before noise begins.

**Expected verdict:** `parse_csv` should report **exactly 1000** type
mismatches. If reported count == 1000 → the dtype counter is sound.
If < 1000 → under-counting; if > 1000 → false-positives in inference.

**Deterministic** — same SEED yields the same bytes, so the answer key
("1000 mismatches") is reproducible across sessions and machines.

Original generator drafted by Gemini in the post-`tricky-100k` bench
review; adapted to the harness conventions (CORPUS_DIR, seeded RNG,
CLI row-count override).

Output:    tools/wasm-bench/corpus/type-truth-<N>k.csv  (gitignored)
Size:      ~3 MB at N=100k

Usage:
    python3 tools/wasm-bench/generate-type-truth.py            # default 100k
    python3 tools/wasm-bench/generate-type-truth.py 500000     # 500k rows
"""

import random
import sys
from pathlib import Path

ROOT       = Path(__file__).resolve().parent
CORPUS_DIR = ROOT / "corpus"
SEED       = 20260526
TRAP_COUNT = 1000   # total mismatches injected — the answer key
TRAP_START = 5000   # first row eligible for a trap (lets inference converge)

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
    out = CORPUS_DIR / f"type-truth-{suffix}.csv"

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

    print(f"Generating {num_rows:,} rows → {out}")
    print(f"  seed = {SEED}")
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

    size_mb = out.stat().st_size / (1024 * 1024)
    print(f"Done — {size_mb:.2f} MB.")


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 100_000
    main(n)
