#!/usr/bin/env python3
"""
Generate the edge-vs-server benchmark corpus (Em 2026-06-01).

Reconstructs the fixtures behind the "edge-compute ingestion" investor POC
that was lost in the Ubuntu 22.04 -> 26.04 migration. Three torture files,
seeded for reproducibility:

  ultimate_tricky.csv   ~0.7 KB  — every CSV trap in 15 rows (wrapped rows,
                                   embedded newlines, unescaped/backslash
                                   quotes, missing+extra columns, emoji,
                                   quote-soup). The rescue regression check.
  mega_tricky_100k.csv  ~7.2 MB  — 100k rows, 70% clean / 30% chaos (11 trap
                                   kinds). The chaotic-volume test.
  type_truth_100k.csv   ~3.9 MB  — 100k rows with EXACTLY 1000 planted type
                                   violations (250 each int/bool/float/date),
                                   ALL at rows >= 5000. The type answer-key.

Run:  python3 tools/wasm-bench/generate-edge-corpus.py [OUT_DIR]
Default OUT_DIR = ./edge-corpus next to this script.

See results/edge-vs-server-2026-06-01.md for the benchmark this feeds.
"""
import os
import random
import sys

SEED = 20260526


def gen_ultimate_tricky(path):
    # Concatenated form (NOT triple-quoted): row 13's """ would otherwise
    # close a Python triple-quoted literal early. \n -> real embedded
    # newline (rows 4, 15); \\\" -> literal backslash-quote (row 8).
    csv = (
        "id,name,description,status,amount\n"
        "1,Alice,Normal row,OK,100.00\n"
        "2,\"Bob, Jr.\",\"Contains, commas\",OK,200.50\n"
        "3,\"Charlie \"\"The Boss\"\"\",\"Quotes \"\" inside\",OK,300.00\n"
        "4,David,\"Multi\nline\ndescription\",OK,400.00\n"
        "5,,,,,\n"
        "\"6,\"\"Eve\"\",\"\"Wrapped in outer quotes\"\",\"\"OK\"\",600.00\"\n"
        "7,Frank \"The Tank\" Smith,Bad unescaped quotes,WARN,700.00\n"
        "8,Grace,Mixed backslash escape \\\",WARN,800.00\n"
        "9,Hank,Missing columns\n"
        "10,Ivy,Extra columns,OK,1000.00,EXTRA1,EXTRA2\n"
        "11,José,UTF-8 encoded text with emoji 🌮🔥,OK,1100.00\n"
        "12,  Kevin  ,  Leading/trailing spaces inside and outside  , OK , 1200.00\n"
        "13,\"\"\"\",\"\"\"\"\"\"\"\",OK,1300.00\n"
        "14,\"Single 'quote'\",\"Mismatched \"\" quote\",ERR,1400.00\n"
        "\"15,\"\"One-col trap\nwith newline\"\",\"\"Inside\"\",\"\"OK\"\",1500\"\n"
    )
    with open(path, "w", encoding="utf-8") as f:
        f.write(csv)
    return len(csv.encode())


def gen_mega_tricky(path, num_rows=100000):
    random.seed(SEED)
    headers = "id,timestamp,user_name,event_description,status,score\n"
    traps = [
        lambda i: f'{i},2026-05-26T12:00:00Z,Alice_Smith,Logged in successfully,OK,{random.uniform(0,100):.2f}\n',
        lambda i: f'{i},2026-05-26T12:05:00Z,"Bob, Jr.","Clicked ""Submit"", then crashed",ERROR,{random.uniform(0,100):.2f}\n',
        lambda i: f'{i},2026-05-26T12:10:00Z,Charlie_X,"Multi-line\ndescription\nright here",OK,{random.uniform(0,100):.2f}\n',
        lambda i: f'"{i},2026-05-26T12:15:00Z,""Dave"",""Wrapped in outer quotes"",""OK"",{random.uniform(0,100):.2f}"\n',
        lambda i: f'{i},2026-05-26T12:20:00Z,Eve,Missing status and score\n',
        lambda i: f'{i},2026-05-26T12:25:00Z,Frank,Extra fields,WARN,{random.uniform(0,100):.2f},EXTRA_1,EXTRA_2\n',
        lambda i: f'{i},2026-05-26T12:30:00Z,José_🌮,Event 🔥 warning 🚨,WARN,{random.uniform(0,100):.2f}\n',
        lambda i: f'{i}  ,  2026-05-26T12:35:00Z  ,  Grace  ,  Spaces everywhere  ,  OK  ,  {random.uniform(0,100):.2f}  \n',
        lambda i: f'{i},2026-05-26T12:40:00Z,Hank,He said "Hello" inside unquoted text,FATAL,{random.uniform(0,100):.2f}\n',
        lambda i: f'{i},2026-05-26T12:45:00Z,"""","""""""",OK,{random.uniform(0,100):.2f}\n',
        lambda i: f'"{i},2026-05-26T12:50:00Z,""Ivy"",""One-col\nwith newline"",""FATAL"",{random.uniform(0,100):.2f}"\n',
    ]
    with open(path, "w", encoding="utf-8") as f:
        f.write(headers)
        for i in range(1, num_rows + 1):
            f.write((traps[0] if random.random() < 0.70 else random.choice(traps[1:]))(i))
    return os.path.getsize(path)


def gen_type_truth(path, num_rows=100000):
    random.seed(SEED)
    headers = "id,is_active,score,category,date_joined\n"
    mismatch_indices = set(random.sample(range(5000, num_rows + 1), 1000))
    trap_types = ['int_trap'] * 250 + ['bool_trap'] * 250 + ['float_trap'] * 250 + ['date_trap'] * 250
    random.shuffle(trap_types)
    trap_map = dict(zip(mismatch_indices, trap_types))
    with open(path, "w", encoding="utf-8") as f:
        f.write(headers)
        for i in range(1, num_rows + 1):
            is_active = random.choice(["true", "false"])
            score = f"{random.uniform(10.0, 99.9):.2f}"
            category = f"Category_{random.choice(['A', 'B', 'C'])}"
            date_joined = f"2026-05-{random.randint(10, 28)}"
            if i in trap_map:
                t = trap_map[i]
                if t == 'int_trap':     f.write(f"{i}.5,{is_active},{score},{category},{date_joined}\n")
                elif t == 'bool_trap':  f.write(f"{i},maybe,{score},{category},{date_joined}\n")
                elif t == 'float_trap': f.write(f"{i},{is_active},NaN_or_Text,{category},{date_joined}\n")
                elif t == 'date_trap':  f.write(f"{i},{is_active},{score},{category},Not_A_Date\n")
            else:
                f.write(f"{i},{is_active},{score},{category},{date_joined}\n")
    return len(mismatch_indices)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "edge-corpus")
    os.makedirs(out, exist_ok=True)
    b = gen_ultimate_tricky(os.path.join(out, "ultimate_tricky.csv"))
    print(f"ultimate_tricky.csv  {b} bytes")
    b = gen_mega_tricky(os.path.join(out, "mega_tricky_100k.csv"))
    print(f"mega_tricky_100k.csv {b} bytes (100k rows, 30% chaos)")
    n = gen_type_truth(os.path.join(out, "type_truth_100k.csv"))
    print(f"type_truth_100k.csv  ANSWER KEY = {n} type mismatches (250 each int/bool/float/date, all at rows >=5000)")


if __name__ == "__main__":
    main()
