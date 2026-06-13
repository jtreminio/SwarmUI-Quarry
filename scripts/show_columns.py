#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb>=1.0"]
# ///
"""Print the column names of a data file as a single comma-delimited line.

Supports Parquet, CSV/TSV, JSONL/NDJSON, and JSON (array or records). The format
is inferred from the extension; override it with ``--format`` for odd names.

Output is just the names, e.g. ``id,name,score,ok`` -- no types, one line.

Usage:
    python show_columns.py <file>
    python show_columns.py data.parquet
    python show_columns.py weird_name --format csv

Run it with the project venv:
    .venv/bin/python scripts/show_columns.py data.parquet

or standalone with uv (deps are declared inline above):
    uv run scripts/show_columns.py data.parquet
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import duckdb

# Map file extension -> logical format.
_EXT_FORMAT = {
    ".parquet": "parquet",
    ".csv": "csv",
    ".tsv": "csv",  # read_csv_auto detects the tab delimiter
    ".jsonl": "jsonl",
    ".ndjson": "jsonl",
    ".json": "json",
}

_FORMATS = ("parquet", "csv", "jsonl", "json")


def detect_format(path: Path, override: str | None) -> str:
    """Return the logical format for the file."""
    if override:
        fmt = override.lower()
        if fmt not in _FORMATS:
            raise SystemExit(
                f"error: unknown --format {override!r} "
                f"(choose from: {', '.join(_FORMATS)})"
            )
        return fmt
    fmt = _EXT_FORMAT.get(path.suffix.lower())
    if fmt is None:
        raise SystemExit(
            f"error: cannot infer format from extension {path.suffix!r}; "
            f"pass --format ({'|'.join(_FORMATS)})"
        )
    return fmt


def quote_literal(value: str) -> str:
    """Single-quote a SQL string literal, escaping embedded single quotes."""
    return "'" + value.replace("'", "''") + "'"


def reader_sql(fmt: str, lit: str) -> str:
    """Build the DuckDB reader call for the given format."""
    if fmt == "parquet":
        return f"read_parquet({lit})"
    if fmt == "csv":
        return f"read_csv_auto({lit})"
    if fmt == "jsonl":
        return f"read_json({lit}, format='newline_delimited')"
    return f"read_json({lit}, format='auto')"  # json (array or records)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Print a file's column names as a single comma-delimited line.",
    )
    parser.add_argument("file", help="path to the data file")
    parser.add_argument(
        "--format",
        choices=_FORMATS,
        default=None,
        help="override the format instead of inferring it from the extension",
    )
    args = parser.parse_args(argv)

    path = Path(args.file)
    if not path.is_file():
        raise SystemExit(f"error: no such file: {path}")

    fmt = detect_format(path, args.format)
    reader = reader_sql(fmt, quote_literal(str(path)))

    con = duckdb.connect()
    try:
        rows = con.execute(f"DESCRIBE SELECT * FROM {reader}").fetchall()
    except duckdb.Error as exc:
        raise SystemExit(f"error: could not read {path} as {fmt}: {exc}")
    finally:
        con.close()

    names = [r[0] for r in rows]
    print(",".join(names))
    return 0


if __name__ == "__main__":
    sys.exit(main())
