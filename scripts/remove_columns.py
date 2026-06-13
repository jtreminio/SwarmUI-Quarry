#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb>=1.0"]
# ///
"""Remove one or more columns from Parquet/CSV/JSONL file(s) in place.

The ``file`` argument may be a single path or a shell-style wildcard pattern
(``*``, ``?``, ``[...]``, ``**``). Each matching file is read, the named
column(s) are dropped, and the result is written back to the *same path* in the
*same format*. Writing goes to a temporary file in the same directory first,
then atomically replaces the original, so an error mid-write leaves the file
untouched. Files are processed concurrently (16 at a time by default, see
``-w``) and independently: a failure on one (e.g. a column it doesn't have) is
reported and the rest still run.

Quote the pattern so the shell passes it through for this script to expand:

    python remove_columns.py '000*.parquet' price,notes   # all 000*.parquet
    python remove_columns.py data.parquet price,notes      # a single file
    python remove_columns.py 'shards/*.jsonl' id --format jsonl
    python remove_columns.py '*.parquet' notes -w 8        # 8 files at a time

Run it with the project venv:
    .venv/bin/python scripts/remove_columns.py '000*.parquet' col_a,col_b

or standalone with uv (deps are declared inline above):
    uv run scripts/remove_columns.py '000*.parquet' col_a,col_b
"""

from __future__ import annotations

import argparse
import glob
import os
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import duckdb

# Map file extension -> logical format.
_EXT_FORMAT = {
    ".parquet": "parquet",
    ".csv": "csv",
    ".jsonl": "jsonl",
    ".ndjson": "jsonl",
}

_READERS = {
    "parquet": "read_parquet",
    "csv": "read_csv_auto",
    "jsonl": "read_json",
}


class FileError(Exception):
    """A per-file problem that should be reported without aborting the batch."""


def detect_format(path: Path, override: str | None) -> str:
    """Return the logical format ('parquet' | 'csv' | 'jsonl')."""
    if override:
        fmt = override.lower()
        if fmt not in _READERS:
            raise SystemExit(
                f"error: unknown --format {override!r} "
                f"(choose from: {', '.join(sorted(_READERS))})"
            )
        return fmt
    fmt = _EXT_FORMAT.get(path.suffix.lower())
    if fmt is None:
        raise FileError(
            f"cannot infer format from extension {path.suffix!r}; "
            f"pass --format (parquet|csv|jsonl)"
        )
    return fmt


def quote_ident(name: str) -> str:
    """Double-quote a SQL identifier, escaping embedded double quotes."""
    return '"' + name.replace('"', '""') + '"'


def quote_literal(value: str) -> str:
    """Single-quote a SQL string literal, escaping embedded single quotes."""
    return "'" + value.replace("'", "''") + "'"


def read_relation_sql(fmt: str, path_param: str = "?") -> str:
    """Build the FROM-clause reader call for the given format."""
    if fmt == "jsonl":
        return f"read_json({path_param}, format='newline_delimited')"
    return f"{_READERS[fmt]}({path_param})"


def copy_options(fmt: str) -> str:
    """DuckDB COPY ... (options) for the given output format."""
    return {
        "parquet": "FORMAT PARQUET",
        "csv": "FORMAT CSV, HEADER",
        "jsonl": "FORMAT JSON",  # newline-delimited (ARRAY false) by default
    }[fmt]


def parse_columns(raw: str) -> list[str]:
    """Split a comma-separated column list, trimming blanks and de-duping."""
    seen: dict[str, None] = {}
    for part in raw.split(","):
        col = part.strip()
        if col and col not in seen:
            seen[col] = None
    return list(seen)


def resolve_files(pattern: str) -> list[Path]:
    """Expand a path-or-wildcard into a sorted list of existing files."""
    matches = sorted(glob.glob(pattern, recursive=True))
    files = [Path(m) for m in matches if os.path.isfile(m)]
    if not files:
        if glob.has_magic(pattern):
            raise SystemExit(f"error: no files match pattern: {pattern}")
        raise SystemExit(f"error: no such file: {pattern}")
    return files


def process_file(
    path: Path,
    targets: list[str],
    fmt_override: str | None,
) -> tuple[str, list[str], list[str]]:
    """Drop ``targets`` from one file in place. Returns (fmt, removed, remaining).

    Opens its own DuckDB connection so it is safe to run from a worker thread.
    """
    fmt = detect_format(path, fmt_override)

    con = duckdb.connect()
    try:
        # Discover the actual column names (DuckDB identifiers are
        # case-insensitive, so match the user's input that way).
        described = con.execute(
            f"DESCRIBE SELECT * FROM {read_relation_sql(fmt)}", [str(path)]
        ).fetchall()
        existing = [row[0] for row in described]
        existing_lower = {name.lower(): name for name in existing}

        missing = [c for c in targets if c.lower() not in existing_lower]
        if missing:
            raise FileError(
                f"column(s) not found: {', '.join(missing)} "
                f"(available: {', '.join(existing)})"
            )

        remove_lower = {c.lower() for c in targets}
        remaining = [n for n in existing if n.lower() not in remove_lower]
        if not remaining:
            raise FileError(
                f"refusing to remove every column "
                f"({len(existing)} requested, 0 would remain)"
            )

        exclude = ", ".join(quote_ident(existing_lower[c.lower()]) for c in targets)

        # Write to a temp file in the same directory, then atomically replace the
        # original so a failure can't corrupt the source file.
        fd, tmp_name = tempfile.mkstemp(
            dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
        )
        os.close(fd)
        tmp_path = Path(tmp_name)
        try:
            con.execute(
                f"COPY (SELECT * EXCLUDE ({exclude}) "
                f"FROM {read_relation_sql(fmt, quote_literal(str(path)))}) "
                f"TO {quote_literal(str(tmp_path))} ({copy_options(fmt)})"
            )
            os.replace(tmp_path, path)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise
    finally:
        con.close()

    removed = [existing_lower[c.lower()] for c in targets]
    return fmt, removed, remaining


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Remove column(s) from parquet/csv/jsonl file(s) in place.",
    )
    parser.add_argument(
        "file",
        help="a file path or quoted wildcard pattern, e.g. '000*.parquet'",
    )
    parser.add_argument(
        "columns",
        help="comma-separated column name(s) to remove, e.g. 'price,notes'",
    )
    parser.add_argument(
        "--format",
        dest="format",
        choices=sorted(_READERS),
        default=None,
        help="override the format instead of inferring it from each extension",
    )
    parser.add_argument(
        "-w",
        "--workers",
        type=int,
        default=16,
        help="how many files to process concurrently (default: 16)",
    )
    args = parser.parse_args(argv)

    targets = parse_columns(args.columns)
    if not targets:
        raise SystemExit("error: no column names given")

    files = resolve_files(args.file)
    workers = max(1, min(args.workers, len(files)))

    ok = 0
    failures: list[tuple[Path, str]] = []
    # Each file gets its own DuckDB connection inside process_file, so the work
    # is thread-safe; we only print from this (the main) thread to keep output
    # lines from interleaving.
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(process_file, path, targets, args.format): path
            for path in files
        }
        for future in as_completed(futures):
            path = futures[future]
            try:
                fmt, removed, remaining = future.result()
            except Exception as exc:  # FileError or a DuckDB read/write error
                failures.append((path, str(exc)))
                print(f"  SKIP {path}: {exc}", file=sys.stderr)
                continue
            ok += 1
            print(
                f"  {path} [{fmt}]: removed {', '.join(removed)} "
                f"-> {len(remaining)} column(s) remain ({', '.join(remaining)})"
            )

    if len(files) > 1 or failures:
        summary = f"Done: {ok}/{len(files)} file(s) updated, removed: {', '.join(targets)}"
        if failures:
            summary += f"; {len(failures)} skipped"
        print(summary, file=sys.stderr)

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
