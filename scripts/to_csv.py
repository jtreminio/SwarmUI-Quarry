#!/usr/bin/env python3
"""Convert a simple TXT file (one value per line) into a single-column CSV.

Usage:
    python scripts/to_csv.py FILENAME.txt COLUMN
"""
import csv
import sys
from pathlib import Path


def main(argv):
    if len(argv) != 3:
        print("Usage: python scripts/to_csv.py FILENAME.txt COLUMN", file=sys.stderr)
        return 2

    txt_path = Path(argv[1])
    column = argv[2]

    if not txt_path.is_file():
        print(f"Error: file not found: {txt_path}", file=sys.stderr)
        return 1

    csv_path = txt_path.with_suffix(".csv")

    with txt_path.open("r", encoding="utf-8") as src, \
            csv_path.open("w", newline="", encoding="utf-8") as dst:
        writer = csv.writer(dst)
        writer.writerow([column])
        for line in src:
            writer.writerow([line.rstrip("\n")])

    print(f"Wrote {csv_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
