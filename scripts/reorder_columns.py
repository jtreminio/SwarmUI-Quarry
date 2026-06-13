#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb>=1.0"]
# ///
"""Move named columns to the front of Parquet/CSV/JSONL file(s) in place.

Given a file and a comma-separated column order, the named columns are placed --
in exactly the order given -- at the *front* of the file; every other column
keeps its existing relative order behind them. For a file with columns
``id,prompt,foo,bar,baz``, passing ``prompt,foo`` yields
``prompt,foo,id,bar,baz``.

The ``file`` argument may be a single path or a shell-style wildcard pattern
(``*``, ``?``, ``[...]``, ``**``). Each matching file is read, its columns are
reordered, and the result is written back to the *same path* in the *same
format*. Writing goes to a temporary file in the same directory first, then
atomically replaces the original, so an error mid-write leaves the file
untouched. A file already in the requested order is left untouched. Files are
processed concurrently (16 at a time by default, see ``-w``) and independently:
a failure on one (e.g. a column it doesn't have) is reported and the rest still
run.

Quote the pattern so the shell passes it through for this script to expand:

    python reorder_columns.py data.parquet prompt,foo         # a single file
    python reorder_columns.py '000*.parquet' prompt,foo       # all 000*.parquet
    python reorder_columns.py 'shards/*.jsonl' text --format jsonl
    python reorder_columns.py '*.parquet' prompt -w 8         # 8 files at a time

Run it with the project venv:
    .venv/bin/python scripts/reorder_columns.py data.parquet prompt,foo

or standalone with uv (deps are declared inline above):
    uv run scripts/reorder_columns.py data.parquet prompt,foo
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


def plan_order(existing: list[str], front: list[str]) -> tuple[list[str], list[str]]:
    """Compute the new column order: ``front`` (in the given order) then the rest.

    Matching is case-insensitive (DuckDB identifiers are), but the names returned
    are the file's canonical casing. Raises ``FileError`` if any front column is
    not present. Returns (front_canonical, new_order).
    """
    existing_lower = {name.lower(): name for name in existing}
    missing = [c for c in front if c.lower() not in existing_lower]
    if missing:
        raise FileError(
            f"column(s) not found: {', '.join(missing)} "
            f"(available: {', '.join(existing)})"
        )
    front_canonical = [existing_lower[c.lower()] for c in front]
    front_lower = {c.lower() for c in front}
    rest = [n for n in existing if n.lower() not in front_lower]
    return front_canonical, front_canonical + rest


def process_file(
    path: Path,
    front: list[str],
    fmt_override: str | None,
) -> tuple[str, list[str], bool]:
    """Reorder one file in place. Returns (fmt, new_order, changed).

    Opens its own DuckDB connection so it is safe to run from a worker thread.
    A file already in the requested order is left on disk untouched.
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

        _, new_order = plan_order(existing, front)
        if new_order == existing:
            return fmt, new_order, False

        select_list = ", ".join(quote_ident(n) for n in new_order)

        # Write to a temp file in the same directory, then atomically replace the
        # original so a failure can't corrupt the source file.
        fd, tmp_name = tempfile.mkstemp(
            dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
        )
        os.close(fd)
        tmp_path = Path(tmp_name)
        try:
            con.execute(
                f"COPY (SELECT {select_list} "
                f"FROM {read_relation_sql(fmt, quote_literal(str(path)))}) "
                f"TO {quote_literal(str(tmp_path))} ({copy_options(fmt)})"
            )
            os.replace(tmp_path, path)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise
    finally:
        con.close()

    return fmt, new_order, True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Move named column(s) to the front of parquet/csv/jsonl file(s) in "
            "place; other columns keep their order behind them."
        ),
    )
    parser.add_argument(
        "file",
        help="a file path or quoted wildcard pattern, e.g. '000*.parquet'",
    )
    parser.add_argument(
        "columns",
        help=(
            "comma-separated column name(s) to move to the front, in order, "
            "e.g. 'prompt,foo'"
        ),
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

    front = parse_columns(args.columns)
    if not front:
        raise SystemExit("error: no column names given")

    files = resolve_files(args.file)
    workers = max(1, min(args.workers, len(files)))

    changed = 0
    unchanged = 0
    failures: list[tuple[Path, str]] = []
    # Each file gets its own DuckDB connection inside process_file, so the work
    # is thread-safe; we only print from this (the main) thread to keep output
    # lines from interleaving.
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(process_file, path, front, args.format): path
            for path in files
        }
        for future in as_completed(futures):
            path = futures[future]
            try:
                fmt, new_order, was_changed = future.result()
            except Exception as exc:  # FileError or a DuckDB read/write error
                failures.append((path, str(exc)))
                print(f"  SKIP {path}: {exc}", file=sys.stderr)
                continue
            if was_changed:
                changed += 1
                print(f"  {path} [{fmt}]: reordered -> {', '.join(new_order)}")
            else:
                unchanged += 1
                print(
                    f"  {path} [{fmt}]: already in order ({', '.join(new_order)})"
                )

    if len(files) > 1 or failures:
        summary = (
            f"Done: {changed}/{len(files)} file(s) reordered"
            f"{f', {unchanged} already in order' if unchanged else ''}"
            f", front: {', '.join(front)}"
        )
        if failures:
            summary += f"; {len(failures)} skipped"
        print(summary, file=sys.stderr)

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
