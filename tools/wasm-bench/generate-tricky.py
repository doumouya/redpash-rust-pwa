#!/usr/bin/env python3
"""
Generate the chaos-at-scale CSV for the WASM Phase C bench harness.

Sibling of `generate.py` — different concern. `generate.py` produces
clean dtype-mixed corpus for steady-state perf measurement;
`generate-tricky.py` produces chaos shapes at volume, stress-testing
Polars's lenient mode + the rescue heuristic at scale.

Distribution: 70% clean rows + 30% chaos. The chaos slice rotates
across 10 trap shapes (same edge cases as
`fixtures/ultimate-tricky.csv` but generated at N=100k+):

    embedded commas + standard quotes
    multi-line cells (embedded `\\n` inside quoted fields)
    one-column wrap trap (entire row in outer quotes)
    missing columns
    extra columns
    UTF-8 multibyte (emojis, accented latin) — tests Rust slice boundaries
    floating whitespace inside + outside quotes
    unescaped internal quotes (strict-parser poison)
    quote soup (doubled-quote runs of 4 and 8)
    one-column wrap WITH embedded newline (combinatorial edge)

**Deterministic** — same SEED yields the same bytes — so bench runs
are comparable across sessions, exactly like `generate.py`.

The rescue heuristic should STAY OFF on output here: 70% clean +
30% mixed-shape (only ~9% wrapped) doesn't satisfy whole-file wrap
signature. That's the design — this file is a parity probe + a
lenient-mode scaling test, not a rescue-path stressor.

Output:    tools/wasm-bench/corpus/tricky-<N>k.csv  (gitignored)
Size:      ~8 MB at N=100k; ~80 MB at N=1M

Usage:
    python3 tools/wasm-bench/generate-tricky.py            # default 100k
    python3 tools/wasm-bench/generate-tricky.py 1000000    # 1M rows
"""

import random
import sys
from pathlib import Path

ROOT       = Path(__file__).resolve().parent
CORPUS_DIR = ROOT / "corpus"
SEED       = 20260526   # bump to regenerate a new (still-deterministic) set
CHAOS_RATE = 0.30       # fraction of rows that come from the trap set

# ─── traps ───────────────────────────────────────────────────────────
# Lambdas — each returns one CSV row (newline-terminated) for a given i.
TRAPS = [
    # 0: clean baseline
    lambda i: f'{i},2026-05-26T12:00:00Z,Alice_Smith,Logged in successfully,OK,{random.uniform(0, 100):.2f}\n',

    # 1: embedded commas + standard quotes
    lambda i: f'{i},2026-05-26T12:05:00Z,"Bob, Jr.","Clicked ""Submit"", then crashed",ERROR,{random.uniform(0, 100):.2f}\n',

    # 2: multi-line cells (literal `\n` inside quoted field)
    lambda i: f'{i},2026-05-26T12:10:00Z,Charlie_X,"Multi-line\ndescription\nright here",OK,{random.uniform(0, 100):.2f}\n',

    # 3: one-col wrap (entire row in outer quotes)
    lambda i: f'"{i},2026-05-26T12:15:00Z,""Dave"",""Wrapped in outer quotes"",""OK"",{random.uniform(0, 100):.2f}"\n',

    # 4: missing columns
    lambda i: f'{i},2026-05-26T12:20:00Z,Eve,Missing status and score\n',

    # 5: extra columns
    lambda i: f'{i},2026-05-26T12:25:00Z,Frank,Extra fields,WARN,{random.uniform(0, 100):.2f},EXTRA_1,EXTRA_2\n',

    # 6: UTF-8 multibyte (emojis + accented latin) — slice-boundary test
    lambda i: f'{i},2026-05-26T12:30:00Z,José_🌮,Event 🔥 warning 🚨,WARN,{random.uniform(0, 100):.2f}\n',

    # 7: floating whitespace inside + outside fields
    lambda i: f'{i}  ,  2026-05-26T12:35:00Z  ,  Grace  ,  Spaces everywhere  ,  OK  ,  {random.uniform(0, 100):.2f}  \n',

    # 8: unescaped internal quotes — strict-parser poison
    lambda i: f'{i},2026-05-26T12:40:00Z,Hank,He said "Hello" inside unquoted text,FATAL,{random.uniform(0, 100):.2f}\n',

    # 9: quote soup
    lambda i: f'{i},2026-05-26T12:45:00Z,"""","""""""",OK,{random.uniform(0, 100):.2f}\n',

    # 10: one-col wrap + embedded newline (combinatorial edge)
    lambda i: f'"{i},2026-05-26T12:50:00Z,""Ivy"",""One-col\nwith newline"",""FATAL"",{random.uniform(0, 100):.2f}"\n',
]

HEADERS = "id,timestamp,user_name,event_description,status,score\n"

# ─── main ────────────────────────────────────────────────────────────
def main(num_rows: int) -> None:
    random.seed(SEED)
    CORPUS_DIR.mkdir(parents=True, exist_ok=True)

    # Filename uses `Nk` suffix for readability; 100000 → tricky-100k.csv
    suffix = f"{num_rows // 1000}k" if num_rows >= 1000 else str(num_rows)
    out = CORPUS_DIR / f"tricky-{suffix}.csv"

    print(f"Generating {num_rows:,} rows → {out}")
    print(f"  seed = {SEED}, chaos rate = {CHAOS_RATE:.0%}")

    chaos_traps = TRAPS[1:]
    with out.open("w", encoding="utf-8") as f:
        f.write(HEADERS)
        for i in range(1, num_rows + 1):
            if random.random() < (1 - CHAOS_RATE):
                row_func = TRAPS[0]
            else:
                row_func = random.choice(chaos_traps)
            f.write(row_func(i))

    size_mb = out.stat().st_size / (1024 * 1024)
    print(f"Done — {size_mb:.2f} MB.")


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 100_000
    main(n)
