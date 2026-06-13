#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb>=1.0"]
# ///
"""Append (row-stack) two or more Parquet/CSV/JSONL files onto a master.

The first file is the *master*; every other file's rows are appended to it.
By default the combined result is written back to the master file in place
(in the master's format). Inputs may mix formats freely.

Columns are aligned *by name* (DuckDB ``UNION ALL BY NAME``): a column missing
from some file is filled with NULL for that file's rows. Use ``--strict`` to
require every file to have the exact same set of columns.

Writing always goes to a temporary file in the destination directory first,
then atomically replaces the target, so a failure mid-write can't corrupt the
master (or an existing --output file).

Inputs may be plain paths and/or wildcard patterns (``*``, ``?``, ``[...]``,
``**``); quote patterns so the shell passes them through for this script to
expand. All matches are flattened, in argument order, into one de-duplicated
list -- the *first* file is the master and the rest are appended onto it. So a
single wildcard just works: ``append_files.py 'dir/*.parquet'`` appends every
matching shard onto the first one.

Usage:
    python append_files.py 'dir/*.parquet'                    # first match = master
    python append_files.py master.parquet 'shard_*.parquet'   # explicit master
    python append_files.py master.parquet jan.parquet feb.parquet
    python append_files.py base.csv extra.jsonl -o combined.parquet
    python append_files.py a.csv b.csv c.csv --strict

Run it with the project venv:
    .venv/bin/python scripts/append_files.py 'dir/*.parquet'

or standalone with uv (deps are declared inline above):
    uv run scripts/append_files.py 'dir/*.parquet'
"""

from __future__ import annotations

import argparse
import glob
import os
import sys
import tempfile
from pathlib import Path

try:
    import duckdb
except ModuleNotFoundError:  # dependency bootstrap so bare `python ...` just works
    import shutil

    # Re-run under uv, which installs the PEP 723 inline deps (duckdb) into an
    # ephemeral env. The env-var guard prevents an infinite re-exec loop.
    if os.environ.get("_APPEND_FILES_UV") != "1" and shutil.which("uv"):
        os.environ["_APPEND_FILES_UV"] = "1"
        os.execvp("uv", ["uv", "run", os.path.abspath(__file__), *sys.argv[1:]])
    raise SystemExit(
        "error: this script needs duckdb -- run it with the project venv "
        "(.venv/bin/python), via `uv run`, or `pip install duckdb`."
    )

# Map file extension -> logical format.
_EXT_FORMAT = {
    ".parquet": "parquet",
    ".csv": "csv",
    ".jsonl": "jsonl",
    ".ndjson": "jsonl",
}

_FORMATS = ("parquet", "csv", "jsonl")


def detect_format(path: Path, override: str | None = None) -> str:
    """Return the logical format ('parquet' | 'csv' | 'jsonl')."""
    if override:
        fmt = override.lower()
        if fmt not in _FORMATS:
            raise SystemExit(
                f"error: unknown format {override!r} "
                f"(choose from: {', '.join(_FORMATS)})"
            )
        return fmt
    fmt = _EXT_FORMAT.get(path.suffix.lower())
    if fmt is None:
        raise SystemExit(
            f"error: cannot infer format from extension {path.suffix!r} ({path}); "
            f"pass --format (parquet|csv|jsonl)"
        )
    return fmt


def quote_literal(value: str) -> str:
    """Single-quote a SQL string literal, escaping embedded single quotes."""
    return "'" + value.replace("'", "''") + "'"


def reader_sql(path: Path) -> str:
    """Build a DuckDB reader call for a single file based on its format."""
    fmt = detect_format(path)
    lit = quote_literal(str(path))
    if fmt == "parquet":
        return f"read_parquet({lit})"
    if fmt == "csv":
        return f"read_csv_auto({lit})"
    return f"read_json({lit}, format='newline_delimited')"


def reader_sql_multi(fmt: str, paths: list[Path]) -> str:
    """Build a single multi-file reader over many same-format files.

    Uses DuckDB's native list-of-files scan with ``union_by_name`` so the files
    are streamed rather than opened all at once -- essential for thousands of
    shards, where a per-file ``UNION ALL`` would exhaust the open-file limit.
    """
    lst = "[" + ", ".join(quote_literal(str(p)) for p in paths) + "]"
    if fmt == "parquet":
        return f"read_parquet({lst}, union_by_name=true)"
    if fmt == "csv":
        return f"read_csv_auto({lst}, union_by_name=true)"
    return f"read_json({lst}, format='newline_delimited', union_by_name=true)"


def copy_options(fmt: str) -> str:
    """DuckDB COPY ... (options) for the given output format."""
    return {
        "parquet": "FORMAT PARQUET",
        "csv": "FORMAT CSV, HEADER",
        "jsonl": "FORMAT JSON",  # newline-delimited (ARRAY false) by default
    }[fmt]


def columns_of(con: duckdb.DuckDBPyConnection, path: Path) -> list[str]:
    """Return the column names of a file as DuckDB reports them."""
    rows = con.execute(f"DESCRIBE SELECT * FROM {reader_sql(path)}").fetchall()
    return [r[0] for r in rows]


def expand_pattern(pattern: str) -> list[Path]:
    """Expand one path-or-wildcard into a sorted list of existing files."""
    matches = sorted(glob.glob(pattern, recursive=True))
    files = [Path(m) for m in matches if os.path.isfile(m)]
    if not files:
        if glob.has_magic(pattern):
            raise SystemExit(f"error: no files match pattern: {pattern}")
        raise SystemExit(f"error: no such file: {pattern}")
    return files


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Append (row-stack) parquet/csv/jsonl files onto a master.",
    )
    parser.add_argument(
        "inputs",
        nargs="+",
        metavar="file",
        help="files and/or quoted wildcard pattern(s); the first matched file is "
        "the master and the rest are appended onto it, e.g. 'shards/*.parquet'",
    )
    parser.add_argument(
        "-o",
        "--output",
        default=None,
        help="write the result here instead of overwriting the master in place",
    )
    parser.add_argument(
        "--format",
        choices=_FORMATS,
        default=None,
        help="override the output format (default: inferred from the destination)",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="require every file to have the exact same set of columns",
    )
    args = parser.parse_args(argv)

    # Expand every path/pattern in order into one de-duplicated file list. The
    # first file is the master; the rest are appended onto it. A single wildcard
    # like 'dir/*.parquet' therefore "just works": master = first match.
    seen: set[Path] = set()
    files: list[Path] = []
    for pattern in args.inputs:
        for path in expand_pattern(pattern):
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            files.append(path)

    if len(files) < 2:
        raise SystemExit(
            f"error: need at least two files to append, but only matched one "
            f"({files[0]}); give more files or a wider pattern"
        )

    master, others = files[0], files[1:]
    all_inputs = files
    dest = Path(args.output) if args.output else master
    out_fmt = detect_format(dest, args.format)

    con = duckdb.connect()
    try:
        if args.strict:
            # Validate every input shares the master's exact column set.
            master_cols = columns_of(con, master)
            master_set = {c.lower() for c in master_cols}
            for other in others:
                cols = columns_of(con, other)
                if {c.lower() for c in cols} != master_set:
                    extra = sorted(set(c.lower() for c in cols) - master_set)
                    absent = sorted(master_set - set(c.lower() for c in cols))
                    detail = []
                    if extra:
                        detail.append(f"extra: {', '.join(extra)}")
                    if absent:
                        detail.append(f"missing: {', '.join(absent)}")
                    raise SystemExit(
                        f"error: --strict column mismatch in {other}\n"
                        f"  master columns: {', '.join(master_cols)}\n"
                        f"  {other.name} columns: {', '.join(cols)}\n"
                        f"  ({'; '.join(detail)})"
                    )

        # Group consecutive same-format files into runs, each read by one
        # multi-file reader, then stack the runs. For the common case (all one
        # format) this is a single scan over the whole list, which streams files
        # instead of opening them all at once. Order is preserved.
        runs: list[tuple[str, list[Path]]] = []
        for path in all_inputs:
            fmt = detect_format(path, None)
            if runs and runs[-1][0] == fmt:
                runs[-1][1].append(path)
            else:
                runs.append((fmt, [path]))

        select_sql = " UNION ALL BY NAME ".join(
            f"SELECT * FROM {reader_sql_multi(fmt, paths)}" for fmt, paths in runs
        )

        # Write to a temp file in the destination dir, then atomically replace,
        # so a failure can't corrupt the master / existing output file.
        fd, tmp_name = tempfile.mkstemp(
            dir=str(dest.parent), prefix=f".{dest.name}.", suffix=".tmp"
        )
        os.close(fd)
        tmp_path = Path(tmp_name)
        try:
            result = con.execute(
                f"COPY ({select_sql}) TO {quote_literal(str(tmp_path))} "
                f"({copy_options(out_fmt)})"
            ).fetchone()
            os.replace(tmp_path, dest)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise
    finally:
        con.close()

    total = result[0] if result else None
    print(
        f"Appended {len(others)} file(s) onto master '{master}' "
        f"({len(all_inputs)} files total)"
        + (f"\nWrote {total} row(s)" if total is not None else "\nWrote result")
        + f" to {dest} [{out_fmt}]"
        + (" (by name; missing columns filled with NULL)" if not args.strict else "")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
