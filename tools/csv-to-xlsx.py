#!/usr/bin/env python3
"""csv-to-xlsx — regenerate the Excel test-fixture corpus from the CSV
stress corpus.

Faithful, line-by-line: no header inference, no type coercion. Every cell
is written as text; ragged rows, preamble lines and blank rows are kept
exactly — so the Excel-reading path gets the same structural stress the
CSV corpus gives the CSV path. Per-file delimiter sniff + encoding
fallback (utf-8-sig -> cp1252 -> latin-1).

Scope: structural dirt only. CSV-specific dirt — encoding, delimiter
ambiguity, quoting — has no equivalent in an xlsx cell grid, so keep the
raw CSVs for testing encoding / delimiter sniffing.

Requires: python3, openpyxl  (pip install openpyxl)

Usage:
  python3 tools/csv-to-xlsx.py [--src DIR] [--dst DIR]
  With no args it regenerates the standard fleury_data_project corpus.
"""
import argparse
import csv
import glob
import io
import os

from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE

DEFAULT_SRC = "/mnt/c/Users/edoum/OneDrive/Apps/fleury_data_project/Projet Data/clean-score/raw-xlsx"
DEFAULT_DST = "/mnt/c/Users/edoum/OneDrive/Apps/fleury_data_project/Projet Data/excel files"
DELIMS = [",", ";", "\t", "|"]


def decode(raw):
    """Best-effort decode of a raw CSV byte string."""
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1", errors="replace")


def sniff_delim(text):
    """Pick the delimiter with the highest total count over the first 20
    non-empty lines."""
    lines = [l for l in text.splitlines() if l.strip()][:20]
    best, best_n = ",", -1
    for d in DELIMS:
        n = sum(l.count(d) for l in lines)
        if n > best_n:
            best, best_n = d, n
    return best


def convert(src, dst):
    """Convert every *.csv in `src` to a .xlsx in `dst`. Returns
    (ok_count, [failure messages])."""
    os.makedirs(dst, exist_ok=True)
    ok, fail = 0, []
    for path in sorted(glob.glob(os.path.join(src, "*.csv"))):
        stem = os.path.splitext(os.path.basename(path))[0]
        try:
            with open(path, "rb") as fh:
                text = decode(fh.read())
            delim = sniff_delim(text)
            rows = list(csv.reader(io.StringIO(text), delimiter=delim))
            wb = Workbook()
            ws = wb.active
            for r, row in enumerate(rows, start=1):
                for c, val in enumerate(row, start=1):
                    v = ILLEGAL_CHARACTERS_RE.sub("", str(val))
                    cell = ws.cell(row=r, column=c)
                    cell.value = v
                    # never let a leading "=" become a formula
                    if v.startswith("="):
                        cell.data_type = "s"
            wb.save(os.path.join(dst, stem + ".xlsx"))
            ok += 1
        except Exception as e:  # noqa: BLE001 - per-file isolation
            fail.append(f"{stem}: {type(e).__name__}: {e}")
    return ok, fail


def main():
    ap = argparse.ArgumentParser(
        description="Convert a CSV corpus to .xlsx test fixtures.")
    ap.add_argument("--src", default=DEFAULT_SRC, help="source dir of .csv files")
    ap.add_argument("--dst", default=DEFAULT_DST, help="output dir for .xlsx files")
    args = ap.parse_args()
    ok, fail = convert(args.src, args.dst)
    print(f"converted {ok}/{ok + len(fail)} -> {args.dst}")
    for f in fail:
        print("  FAIL", f)


if __name__ == "__main__":
    main()
