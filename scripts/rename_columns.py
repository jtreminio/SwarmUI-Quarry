#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb>=1.0"]
# ///
"""Rename columns in Parquet/CSV/JSONL file(s) in place, preserving column order.

Renames are given as a semicolon-separated list of ``old=new`` pairs:

    Prompt=prompt;foo=bar;qwe=tags

As a shorthand, a bare column name with no ``=`` is renamed to ``prompt`` -- so
``summary_en`` means the same as ``summary_en=prompt``. (This is the common case
of pointing the extension at whichever column holds the prompt text.)

Each ``old`` is matched against the file's columns case-insensitively (DuckDB
identifiers are), and renamed to ``new`` exactly as written. Columns not named
are left untouched, and every column keeps its existing position -- only the
header names change.

The ``file`` argument may be a single path or a shell-style wildcard pattern
(``*``, ``?``, ``[...]``, ``**``). Each matching file is read, its columns are
renamed, and the result is written back to the *same path* in the *same format*.
Writing goes to a temporary file in the same directory first, then atomically
replaces the original, so an error mid-write leaves the file untouched. A file
that already has the requested names is left untouched. Files are processed
concurrently (16 at a time by default, see ``-w``) and independently: a failure
on one (e.g. a column it doesn't have) is reported and the rest still run.

Quote the mapping so the shell passes the ``;`` through to this script:

    python rename_columns.py data.parquet 'Prompt=prompt;foo=bar'
    python rename_columns.py data.parquet summary_en               # -> summary_en=prompt
    python rename_columns.py '000*.parquet' 'Prompt=prompt'      # all 000*.parquet
    python rename_columns.py 'shards/*.jsonl' 'text=prompt' --format jsonl
    python rename_columns.py '*.parquet' 'a=b' -w 8              # 8 files at a time

Run it with the project venv:
    .venv/bin/python scripts/rename_columns.py data.parquet 'Prompt=prompt'

or standalone with uv (deps are declared inline above):
    uv run scripts/rename_columns.py data.parquet 'Prompt=prompt'
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

# A bare column name (no '=new') is renamed to this -- the usual "point at the prompt column" case.
_DEFAULT_TARGET = "prompt"


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


def parse_renames(raw: str) -> list[tuple[str, str]]:
    """Parse 'old=new;old2=new2' into ordered (old, new) pairs.

    Splits on ';' then the first '=' of each chunk. Blank chunks are skipped. A
    bare chunk with no '=' (e.g. ``summary_en``) defaults its target to
    ``prompt``. Rejects malformed chunks (an empty ``old``, or an explicit '='
    with an empty target) and an ``old`` named more than once (case-insensitively).
    """
    pairs: list[tuple[str, str]] = []
    seen_old: dict[str, None] = {}
    for chunk in raw.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        old, sep, new = chunk.partition("=")
        old = old.strip()
        new = new.strip()
        if not old or (sep and not new):
            raise SystemExit(
                f"error: bad rename {chunk!r}, expected 'old=new' or a bare "
                f"column name (renamed to {_DEFAULT_TARGET!r})"
            )
        if not sep:
            new = _DEFAULT_TARGET
        key = old.lower()
        if key in seen_old:
            raise SystemExit(f"error: column {old!r} renamed more than once")
        seen_old[key] = None
        pairs.append((old, new))
    return pairs


def resolve_files(pattern: str) -> list[Path]:
    """Expand a path-or-wildcard into a sorted list of existing files."""
    matches = sorted(glob.glob(pattern, recursive=True))
    files = [Path(m) for m in matches if os.path.isfile(m)]
    if not files:
        if glob.has_magic(pattern):
            raise SystemExit(f"error: no files match pattern: {pattern}")
        raise SystemExit(f"error: no such file: {pattern}")
    return files


def plan_renames(
    existing: list[str], renames: list[tuple[str, str]]
) -> tuple[list[str], list[str]]:
    """Compute the per-column SELECT parts and the resulting column names.

    Matching is case-insensitive against ``existing`` (canonical casing kept for
    untouched columns); new names are used exactly as given. Raises ``FileError``
    if an ``old`` is absent or if the renames would collide with another column.
    Returns (select_parts, new_names), both in the original column order.
    """
    existing_lower = {name.lower(): name for name in existing}
    missing = [old for old, _ in renames if old.lower() not in existing_lower]
    if missing:
        raise FileError(
            f"column(s) not found: {', '.join(missing)} "
            f"(available: {', '.join(existing)})"
        )
    rename_map = {old.lower(): new for old, new in renames}

    select_parts: list[str] = []
    new_names: list[str] = []
    for col in existing:
        new = rename_map.get(col.lower())
        if new is None:
            select_parts.append(quote_ident(col))
            new_names.append(col)
        else:
            select_parts.append(f"{quote_ident(col)} AS {quote_ident(new)}")
            new_names.append(new)

    lowered = [n.lower() for n in new_names]
    dupes = sorted({n for n in lowered if lowered.count(n) > 1})
    if dupes:
        raise FileError(
            f"rename would create duplicate column name(s): {', '.join(dupes)}"
        )
    return select_parts, new_names


def process_file(
    path: Path,
    renames: list[tuple[str, str]],
    fmt_override: str | None,
) -> tuple[str, list[tuple[str, str]], bool]:
    """Rename columns in one file in place. Returns (fmt, applied, changed).

    ``applied`` is the (old_canonical, new) pairs that matched, in column order.
    Opens its own DuckDB connection so it is safe to run from a worker thread. A
    file already carrying the requested names is left on disk untouched.
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

        select_parts, new_names = plan_renames(existing, renames)
        rename_map = {old.lower(): new for old, new in renames}
        applied = [
            (col, rename_map[col.lower()])
            for col in existing
            if col.lower() in rename_map
        ]
        if new_names == existing:
            return fmt, applied, False

        select_list = ", ".join(select_parts)

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

    return fmt, applied, True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Rename column(s) in parquet/csv/jsonl file(s) in place, preserving "
            "column order."
        ),
    )
    parser.add_argument(
        "file",
        help="a file path or quoted wildcard pattern, e.g. '000*.parquet'",
    )
    parser.add_argument(
        "renames",
        help=(
            "semicolon-separated old=new pairs, e.g. "
            "'Prompt=prompt;foo=bar;qwe=tags'; a bare column name (e.g. "
            "'summary_en') is shorthand for 'summary_en=prompt'"
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

    renames = parse_renames(args.renames)
    if not renames:
        raise SystemExit("error: no renames given")

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
            pool.submit(process_file, path, renames, args.format): path
            for path in files
        }
        for future in as_completed(futures):
            path = futures[future]
            try:
                fmt, applied, was_changed = future.result()
            except Exception as exc:  # FileError or a DuckDB read/write error
                failures.append((path, str(exc)))
                print(f"  SKIP {path}: {exc}", file=sys.stderr)
                continue
            mapping = ", ".join(f"{old} -> {new}" for old, new in applied)
            if was_changed:
                changed += 1
                print(f"  {path} [{fmt}]: renamed {mapping}")
            else:
                unchanged += 1
                print(f"  {path} [{fmt}]: already named as requested ({mapping})")

    if len(files) > 1 or failures:
        pairs = "; ".join(f"{old}={new}" for old, new in renames)
        summary = (
            f"Done: {changed}/{len(files)} file(s) renamed"
            f"{f', {unchanged} unchanged' if unchanged else ''}"
            f", renames: {pairs}"
        )
        if failures:
            summary += f"; {len(failures)} skipped"
        print(summary, file=sys.stderr)

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
