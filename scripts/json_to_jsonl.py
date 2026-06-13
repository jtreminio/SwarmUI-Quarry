#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Convert a JSON file (an array of objects) to JSONL -- one object per line.

A pretty-printed JSON array like

    [
      { "id": 1, ... },
      { "id": 2, ... }
    ]

becomes newline-delimited JSON (JSONL / NDJSON):

    {"id":1,...}
    {"id":2,...}

Each array element is written verbatim onto its own compact line -- the object's
own keys and their order are preserved, nothing is added or unified across
records (unlike a tabular reader). A top-level single object is written as one
line. Output is written to a temp file first, then atomically moved into place.

Usage:
    python json_to_jsonl.py <file.json> [-o out.jsonl]
    python json_to_jsonl.py DamarJati.mj-disney.json        # -> DamarJati.mj-disney.jsonl
    python json_to_jsonl.py data.json -o /tmp/data.jsonl

Run it with the project venv:
    .venv/bin/python scripts/json_to_jsonl.py data.json

or standalone with uv (no third-party deps):
    uv run scripts/json_to_jsonl.py data.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Convert a JSON array file to JSONL (one object per line).",
    )
    parser.add_argument("input", help="path to the source .json file")
    parser.add_argument(
        "-o",
        "--output",
        default=None,
        help="output path (default: the input with a .jsonl extension)",
    )
    parser.add_argument(
        "--ascii",
        action="store_true",
        help="escape non-ASCII characters (default: keep them as UTF-8)",
    )
    args = parser.parse_args(argv)

    in_path = Path(args.input)
    if not in_path.is_file():
        raise SystemExit(f"error: no such file: {in_path}")

    out_path = Path(args.output) if args.output else in_path.with_suffix(".jsonl")
    if out_path.resolve() == in_path.resolve():
        raise SystemExit(
            f"error: output would overwrite the input ({in_path}); pass -o"
        )

    try:
        with in_path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"error: {in_path} is not valid JSON: {exc}")

    if isinstance(data, list):
        records = data
    elif isinstance(data, dict):
        records = [data]  # a single object becomes a single line
    else:
        raise SystemExit(
            "error: top-level JSON must be an array of objects "
            f"(or a single object), got {type(data).__name__}"
        )

    # Write to a temp file in the destination dir, then atomically replace, so a
    # failure mid-write can't leave a truncated output file behind.
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(out_path.parent), prefix=f".{out_path.name}.", suffix=".tmp"
    )
    os.close(fd)
    tmp_path = Path(tmp_name)
    count = 0
    try:
        with tmp_path.open("w", encoding="utf-8") as out:
            for record in records:
                out.write(
                    json.dumps(
                        record, ensure_ascii=args.ascii, separators=(",", ":")
                    )
                )
                out.write("\n")
                count += 1
        os.replace(tmp_path, out_path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise

    print(f"Wrote {count} record(s) to {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
