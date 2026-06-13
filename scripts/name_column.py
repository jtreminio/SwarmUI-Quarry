#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb>=1.0"]
# ///
"""Give a name to the single column of a file whose header was never defined.

Some single-column data files (e.g. ``DamarJati.SD-Prompts.parquet``) were
written with no header, so the *first value* ended up masquerading as the column
name. Reading them shows a "column" whose name is really a row of data:

    column: 'A portrait of a fierce warrior queen ...'   <- actually a value
    235 rows ...                                          <- the rest of the data

This script takes the file and one column name and rewrites it with a proper,
single named column. The orphaned value sitting in the name slot is recovered as
the first row, so no data is lost.

What counts as "orphaned" depends on the format:
  * parquet / csv -- the reader absorbs the first value into the column name,
    so that value is prepended back as the first row (235 -> 236 rows).
  * jsonl -- bare values read as a placeholder column ('json') with every value
    already present, so the column is simply renamed (no row added).

Override the default with --recover (always prepend the old name) or
--rename-only (never prepend; just rename). The result is written to a temp file
and atomically moved into place (or to --output).

Usage:
    python name_column.py <file> <column_name> [-o OUT]
    python name_column.py DamarJati.SD-Prompts.parquet prompt
    python name_column.py prompts.jsonl text

Run with the project venv:
    .venv/bin/python scripts/name_column.py DamarJati.SD-Prompts.parquet prompt

or standalone with uv (deps declared inline above):
    uv run scripts/name_column.py DamarJati.SD-Prompts.parquet prompt
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from pathlib import Path

import duckdb

# Map file extension -> logical format.
_EXT_FORMAT = {
    ".parquet": "parquet",
    ".csv": "csv",
    ".jsonl": "jsonl",
    ".ndjson": "jsonl",
}

_FORMATS = ("parquet", "csv", "jsonl")


def detect_format(path: Path, override: str | None) -> str:
    """Return the logical format ('parquet' | 'csv' | 'jsonl')."""
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


def quote_ident(name: str) -> str:
    """Double-quote a SQL identifier, escaping embedded double quotes."""
    return '"' + name.replace('"', '""') + '"'


def quote_literal(value: str) -> str:
    """Single-quote a SQL string literal, escaping embedded single quotes."""
    return "'" + value.replace("'", "''") + "'"


def reader_sql(fmt: str, lit: str) -> str:
    """Build the DuckDB reader call for the given format."""
    if fmt == "parquet":
        return f"read_parquet({lit})"
    if fmt == "csv":
        return f"read_csv_auto({lit})"
    return f"read_json({lit}, format='newline_delimited')"


def copy_options(fmt: str) -> str:
    """DuckDB COPY ... (options) for the given output format."""
    return {
        "parquet": "FORMAT PARQUET",
        "csv": "FORMAT CSV, HEADER",
        "jsonl": "FORMAT JSON",  # newline-delimited
    }[fmt]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Name the single column of a header-less parquet/csv/jsonl file.",
    )
    parser.add_argument("file", help="the single-column file to fix")
    parser.add_argument("column", help="the name to give the column, e.g. 'prompt'")
    parser.add_argument(
        "-o",
        "--output",
        default=None,
        help="write the result here instead of overwriting the file in place",
    )
    parser.add_argument(
        "--format",
        choices=_FORMATS,
        default=None,
        help="override the format instead of inferring it from the extension",
    )
    recovery = parser.add_mutually_exclusive_group()
    recovery.add_argument(
        "--recover",
        action="store_true",
        help="always prepend the current column name back as the first row",
    )
    recovery.add_argument(
        "--rename-only",
        action="store_true",
        help="never prepend; just rename the existing column",
    )
    args = parser.parse_args(argv)

    path = Path(args.file)
    if not path.is_file():
        raise SystemExit(f"error: no such file: {path}")

    new_name = args.column.strip()
    if not new_name:
        raise SystemExit("error: column name is empty")

    fmt = detect_format(path, args.format)
    dest = Path(args.output) if args.output else path
    reader = reader_sql(fmt, quote_literal(str(path)))

    con = duckdb.connect()
    try:
        described = con.execute(f"DESCRIBE SELECT * FROM {reader}").fetchall()
        existing = [r[0] for r in described]
        if len(existing) != 1:
            raise SystemExit(
                f"error: expected a single column, but {path.name} has "
                f"{len(existing)}: {', '.join(existing)}\n"
                "this tool only fixes single-column files with a missing header"
            )
        old_name = existing[0]

        # Decide whether the current name is an orphaned value to recover.
        if args.recover:
            recover = True
        elif args.rename_only:
            recover = False
        else:
            # parquet/csv absorb the first value into the name; jsonl does not.
            recover = fmt != "jsonl"

        old_ident = quote_ident(old_name)
        new_ident = quote_ident(new_name)
        if recover:
            # Prepend the orphaned value (the old name) as the first row, then
            # the existing rows in file order.
            select_sql = (
                f"SELECT {quote_literal(old_name)} AS {new_ident} "
                f"UNION ALL "
                f"SELECT {old_ident} AS {new_ident} FROM {reader}"
            )
        else:
            select_sql = f"SELECT {old_ident} AS {new_ident} FROM {reader}"

        # Write to a temp file in the destination dir, then atomically replace.
        fd, tmp_name = tempfile.mkstemp(
            dir=str(dest.parent), prefix=f".{dest.name}.", suffix=".tmp"
        )
        os.close(fd)
        tmp_path = Path(tmp_name)
        try:
            result = con.execute(
                f"COPY ({select_sql}) TO {quote_literal(str(tmp_path))} "
                f"({copy_options(fmt)})"
            ).fetchone()
            os.replace(tmp_path, dest)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise
    finally:
        con.close()

    total = result[0] if result else None
    action = (
        f"recovered orphaned value as the first row, renamed column -> {new_name!r}"
        if recover
        else f"renamed column {old_name!r} -> {new_name!r}"
    )
    print(
        f"{path} [{fmt}]: {action}\n"
        f"Wrote {total} row(s) to {dest}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
