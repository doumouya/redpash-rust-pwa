#!/usr/bin/env python3
"""
Parametric synthetic CSV corpus for the RedPash wasm perf bench.

Ported from the prerelease tools/wasm-bench/generate.py (datatool/data),
made parametric so the per-op scaling sweep emits the SAME schema at every
row count — so a curve measures rows, not columns.

    --shape wide    20-col mixed-dtype (int/str/float/date/datetime/bool/enum)
                    — the realistic target; stresses every dtype-inference
                    branch parse_score exercises.
    --shape narrow   5-col sensor/temps shape — the size-budget edge.

Deterministic per (shape, seed) so repeated bench runs are byte-comparable.

Usage:
    python3 generate.py --rows 100000 --shape wide --out corpus/wide-100000.csv
    python3 generate.py --rows 431000 --shape narrow --out corpus/narrow-431000.csv
"""

import argparse
import csv
import random
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

SEED = 20260525  # change to regenerate a new but still-deterministic set

FIRST_NAMES = ["Ada", "Alan", "Bjarne", "Brendan", "Dennis", "Donald",
               "Edsger", "Grace", "Guido", "James", "Joe", "John",
               "Ken", "Larry", "Linus", "Margaret", "Niklaus", "Rob",
               "Tim", "Yukihiro"]
LAST_NAMES = ["Lovelace", "Turing", "Stroustrup", "Eich", "Ritchie",
              "Knuth", "Dijkstra", "Hopper", "vanRossum", "Gosling",
              "Armstrong", "McCarthy", "Thompson", "Page", "Torvalds",
              "Hamilton", "Wirth", "Pike", "BernersLee", "Matsumoto"]
COUNTRIES = ["USA", "GBR", "FRA", "DEU", "JPN", "AUS", "CAN", "BRA",
             "IND", "CHN", "ZAF", "NLD"]
STATUSES = ["pending", "active", "paused", "closed", "review"]
REGIONS = ["NA-East", "NA-West", "EU-North", "EU-South", "APAC", "LATAM"]


def gen_wide(n_rows: int) -> list[list[str]]:
    """20-column mixed-type schema — the realistic dtype-inference target."""
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
        first = random.choice(FIRST_NAMES)
        last = random.choice(LAST_NAMES)
        created = base + timedelta(days=random.randint(0, 144))
        updated = created + timedelta(days=random.randint(0, 30))
        login = datetime.combine(updated, datetime.min.time()) + timedelta(hours=random.randint(0, 720))
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
            ",".join(random.sample(["a", "b", "c", "d", "e", "f"], k=random.randint(1, 3))),
            str(random.randint(1, 5)),
            random.choice(REGIONS),
            f"{random.uniform(-500, 50000):.2f}",
            updated.isoformat(),
            "|".join(random.sample(["fa", "fb", "fc", "fd"], k=random.randint(0, 2))) or "none",
            f"row {i + 1} - {first} {last}, {random.choice(STATUSES)}",
        ])
    return rows


def gen_narrow(n_rows: int) -> list[list[str]]:
    """5-column sensor/temps shape — the size-budget edge."""
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


SHAPES = {"wide": gen_wide, "narrow": gen_narrow}


def main() -> int:
    ap = argparse.ArgumentParser(description="parametric bench corpus")
    ap.add_argument("--rows", type=int, required=True)
    ap.add_argument("--shape", choices=SHAPES, default="wide")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--seed", type=int, default=None, help="override SEED")
    args = ap.parse_args()

    if args.seed is not None:
        global SEED
        SEED = args.seed

    args.out.parent.mkdir(parents=True, exist_ok=True)
    rows = SHAPES[args.shape](args.rows)
    with args.out.open("w", newline="") as f:
        csv.writer(f).writerows(rows)

    mb = args.out.stat().st_size / 1024 / 1024
    print(f"  {args.out}  {len(rows) - 1:>8,} rows x {len(rows[0]):>2} cols  {mb:7.2f} MB", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
