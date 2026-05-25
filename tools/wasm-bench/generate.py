#!/usr/bin/env python3
"""
Generate the synthetic CSV corpus for the WASM Phase C bench harness.

Three shapes per the roadmap §5 + Gus's measurement recommendation
(Woz.md 18:56) — small baseline / target / large edge:

    small.csv        178 rows  × 10 cols   — parser fixed-cost floor
    medium.csv     10,000 rows × 20 cols   — the §5 Phase C target
    large.csv     431,000 rows ×  5 cols   — size-budget edge (the
                                              temps shape from corpus)

Deterministic — same seed yields the same bytes — so repeated bench
runs are comparable. Output lands in `tools/wasm-bench/corpus/`
(gitignored; regenerated on demand).

Column types are mixed (int / string / float / date / bool / enum)
so dtype::summarize and cleanness_report have real inference to do.
The medium file's 20-column schema is chosen to stress every dtype
branch the wasm parse will exercise in production.

Usage:  python3 tools/wasm-bench/generate.py
"""

import csv
import os
import random
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT       = Path(__file__).resolve().parent
CORPUS_DIR = ROOT / "corpus"
SEED       = 20260525   # change to regenerate a new but still-deterministic set

# ─── Generators ──────────────────────────────────────────────────────

FIRST_NAMES = ["Ada", "Alan", "Bjarne", "Brendan", "Dennis", "Donald",
               "Edsger", "Grace", "Guido", "James", "Joe", "John",
               "Ken", "Larry", "Linus", "Margaret", "Niklaus", "Rob",
               "Tim", "Yukihiro"]
LAST_NAMES  = ["Lovelace", "Turing", "Stroustrup", "Eich", "Ritchie",
               "Knuth", "Dijkstra", "Hopper", "vanRossum", "Gosling",
               "Armstrong", "McCarthy", "Thompson", "Page", "Torvalds",
               "Hamilton", "Wirth", "Pike", "BernersLee", "Matsumoto"]
COUNTRIES   = ["USA", "GBR", "FRA", "DEU", "JPN", "AUS", "CAN", "BRA",
               "IND", "CHN", "ZAF", "NLD"]
STATUSES    = ["pending", "active", "paused", "closed", "review"]
REGIONS     = ["NA-East", "NA-West", "EU-North", "EU-South", "APAC", "LATAM"]


def gen_medium(n_rows: int) -> list[list[str]]:
    """20-column mixed-type schema for the §5 Phase C target."""
    random.seed(SEED)
    base = date(2026, 1, 1)
    header = [
        "id", "user_id", "email", "created_at", "amount", "status",
        "active", "first_name", "last_name", "country", "score",
        "visits", "last_login", "tags", "priority", "region",
        "balance", "updated_at", "flags", "description",
    ]
    rows = [header]
    for i in range(n_rows):
        first   = random.choice(FIRST_NAMES)
        last    = random.choice(LAST_NAMES)
        created = base + timedelta(days=random.randint(0, 144))
        updated = created + timedelta(days=random.randint(0, 30))
        login   = datetime.combine(updated, datetime.min.time()) + timedelta(hours=random.randint(0, 720))
        rows.append([
            str(i + 1),
            f"USR_{i + 1:08X}",
            f"{first.lower()}.{last.lower()}{i}@redpash.io",
            created.isoformat(),
            f"{random.uniform(10, 9999):.2f}",
            random.choice(STATUSES),
            "true" if random.random() < 0.62 else "false",
            first,
            last,
            random.choice(COUNTRIES),
            f"{random.uniform(0, 100):.1f}",
            str(random.randint(0, 4096)),
            login.isoformat(timespec="seconds"),
            ",".join(random.sample(["a", "b", "c", "d", "e", "f"],
                                   k=random.randint(1, 3))),
            str(random.randint(1, 5)),
            random.choice(REGIONS),
            f"{random.uniform(-500, 50000):.2f}",
            updated.isoformat(),
            "|".join(random.sample(["fa", "fb", "fc", "fd"],
                                   k=random.randint(0, 2))) or "none",
            f"row {i + 1} — {first} {last}, {random.choice(STATUSES)}",
        ])
    return rows


def gen_small(n_rows: int) -> list[list[str]]:
    """10-column subset for the baseline. Same generator, narrower."""
    full = gen_medium(n_rows)
    keep = [0, 1, 2, 3, 4, 5, 6, 9, 10, 14]   # subset of medium's cols
    return [[row[i] for i in keep] for row in full]


def gen_large(n_rows: int) -> list[list[str]]:
    """5-column temps-shape edge for the size-budget data point."""
    random.seed(SEED + 1)
    base = datetime(2026, 1, 1)
    header = ["ts", "sensor_id", "temp_c", "humidity_pct", "status"]
    rows = [header]
    for i in range(n_rows):
        ts = base + timedelta(seconds=i * 60)
        rows.append([
            ts.isoformat(timespec="seconds"),
            f"SNS_{(i % 200) + 1:04d}",
            f"{random.uniform(-10, 45):.2f}",
            f"{random.uniform(20, 95):.1f}",
            random.choice(["ok", "warn", "fault"]),
        ])
    return rows


# ─── Driver ─────────────────────────────────────────────────────────

def write(name: str, rows: list[list[str]]) -> None:
    path = CORPUS_DIR / name
    with path.open("w", newline="") as f:
        csv.writer(f).writerows(rows)
    bytes_ = path.stat().st_size
    mb = bytes_ / 1024 / 1024
    print(f"  {path.relative_to(ROOT.parent.parent)}"
          f"  {len(rows) - 1:>7,} rows × {len(rows[0]):>2} cols"
          f"  {mb:6.2f} MB")


def main() -> int:
    CORPUS_DIR.mkdir(exist_ok=True)
    print("Generating bench corpus into tools/wasm-bench/corpus/ …")
    write("small.csv",  gen_small(178))
    write("medium.csv", gen_medium(10_000))
    write("large.csv",  gen_large(431_000))
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
