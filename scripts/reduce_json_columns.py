#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb>=1.0"]
# ///
"""Reduce JSON-valued columns to a nested value in Parquet/CSV/JSONL file(s).

Some datasets carry whole JSON documents in a column -- either as a native
struct/list (e.g. ``conversations STRUCT("from" VARCHAR, "value" VARCHAR)[]``)
or as a raw JSON string (e.g. ``meta VARCHAR``). This script replaces such a
column *in place* with a single nested value pulled out of it, leaving every
other column (and the column order) untouched.

Extractions are given as a semicolon-separated list of ``column=path`` pairs,
where ``path`` is a dot-separated walk into the JSON. Integer segments index
into arrays/lists; everything else is an object key:

    conversations=0.value;meta=prompt

For a row where
``conversations = [{"from":"human","value":"...A..."},{"from":"gpt","value":"<image>"}]``
and
``meta = {"image_id":"...","prompt":"...B...","re-prompt":"...A..."}``
that yields ``conversations = "...A..."`` (element 0's ``value``) and
``meta = "...B..."`` (the root ``prompt``). Keys with special characters work
too, e.g. ``meta=re-prompt``.

Each ``column`` is matched case-insensitively (DuckDB identifiers are). Native
columns are read as JSON via ``to_json``; VARCHAR/JSON columns are parsed as
JSON text. Scalars come out clean and unquoted; if a path points at a nested
object/array, its JSON text is kept. Before writing, the path is probed against
the first rows of the file and a path that matches nothing (a typo, or a column
already reduced by a previous run) is reported and skipped -- so re-running with
a stale path won't silently null a column.

The ``file`` argument may be a single path or a shell-style wildcard pattern
(``*``, ``?``, ``[...]``, ``**``). Each matching file is read, reduced, and
written back to the *same path* in the *same format*. Writing goes to a
temporary file in the same directory first, then atomically replaces the
original, so an error mid-write leaves the file untouched. Files are processed
concurrently (16 at a time by default, see ``-w``) and independently: a failure
on one is reported and the rest still run.

Quote the mapping so the shell passes the ``;`` through to this script:

    python reduce_json_columns.py data.parquet 'conversations=0.value;meta=prompt'
    python reduce_json_columns.py '000*.parquet' 'meta=prompt'
    python reduce_json_columns.py 'shards/*.jsonl' 'conversations=0.value' --format jsonl

Run it with the project venv:
    .venv/bin/python scripts/reduce_json_columns.py data.parquet 'meta=prompt'

or standalone with uv (deps are declared inline above):
    uv run scripts/reduce_json_columns.py data.parquet 'meta=prompt'
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

# How many leading rows to probe when checking that a path matches anything.
_PROBE_ROWS = 200


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


def parse_extractions(raw: str) -> list[tuple[str, str]]:
    """Parse 'column=path;column2=path2' into ordered (column, path) pairs.

    Splits on ';' then the first '=' of each chunk. Blank chunks are skipped.
    Rejects malformed chunks (no '=', or an empty side) and a column named more
    than once (case-insensitively).
    """
    pairs: list[tuple[str, str]] = []
    seen: dict[str, None] = {}
    for chunk in raw.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        col, sep, path = chunk.partition("=")
        col = col.strip()
        path = path.strip()
        if not sep or not col or not path:
            raise SystemExit(
                f"error: bad extraction {chunk!r}, expected 'column=path'"
            )
        key = col.lower()
        if key in seen:
            raise SystemExit(f"error: column {col!r} reduced more than once")
        seen[key] = None
        pairs.append((col, path))
    return pairs


def path_to_pointer(path: str) -> str:
    """Convert a dot-path ('0.value', 'prompt') to a JSON Pointer ('/0/value').

    Each segment becomes one pointer step; DuckDB resolves an integer step as an
    array index and anything else as an object key. Per RFC 6901, '~' and '/'
    inside a segment are escaped to '~0' and '~1'. Raises on an empty segment.
    """
    segments = path.split(".")
    if any(seg == "" for seg in segments):
        raise SystemExit(
            f"error: bad path {path!r}: empty segment (check for stray dots)"
        )
    escaped = [seg.replace("~", "~0").replace("/", "~1") for seg in segments]
    return "/" + "/".join(escaped)


def extract_expr(col_ident: str, col_type: str, pointer: str) -> str:
    """SQL that pulls ``pointer`` out of column ``col_ident`` as VARCHAR.

    VARCHAR/JSON columns are read as JSON text directly; any other (native
    nested) type is converted with ``to_json`` first. A scalar comes back clean
    and unquoted via ``json_extract_string``; a nested object/array falls back to
    its JSON text via ``json_extract``.
    """
    source = (
        col_ident
        if col_type.upper() in ("VARCHAR", "JSON")
        else f"to_json({col_ident})"
    )
    ptr = quote_literal(pointer)
    return (
        f"coalesce(json_extract_string({source}, {ptr}), "
        f"CAST(json_extract({source}, {ptr}) AS VARCHAR))"
    )


def process_file(
    path: Path,
    extractions: list[tuple[str, str]],
    fmt_override: str | None,
) -> tuple[str, list[tuple[str, str]]]:
    """Reduce the requested columns of one file in place. Returns (fmt, applied).

    ``applied`` is the (column_canonical, path) pairs that were reduced, in
    column order. Opens its own DuckDB connection so it is safe to run from a
    worker thread.
    """
    fmt = detect_format(path, fmt_override)

    con = duckdb.connect()
    try:
        # Discover the actual column names and types (identifiers are matched
        # case-insensitively, like DuckDB does).
        described = con.execute(
            f"DESCRIBE SELECT * FROM {read_relation_sql(fmt)}", [str(path)]
        ).fetchall()
        existing = [(row[0], row[1]) for row in described]
        existing_lower = {name.lower() for name, _ in existing}

        target_path = {col.lower(): path_str for col, path_str in extractions}
        missing = [col for col, _ in extractions if col.lower() not in existing_lower]
        if missing:
            available = ", ".join(name for name, _ in existing)
            raise FileError(
                f"column(s) not found: {', '.join(missing)} (available: {available})"
            )

        reader = read_relation_sql(fmt, quote_literal(str(path)))

        select_parts: list[str] = []
        applied: list[tuple[str, str]] = []
        for name, col_type in existing:
            path_str = target_path.get(name.lower())
            if path_str is None:
                select_parts.append(quote_ident(name))
                continue
            ident = quote_ident(name)
            expr = extract_expr(ident, col_type, path_to_pointer(path_str))
            # Probe the first rows: if the source has values but the path pulls
            # out nothing, it is almost certainly wrong (typo / already reduced).
            src_n, out_n = con.execute(
                f"SELECT count(*) FILTER (WHERE {ident} IS NOT NULL), count({expr}) "
                f"FROM (SELECT * FROM {reader} LIMIT {_PROBE_ROWS}) t"
            ).fetchone()
            if src_n and not out_n:
                raise FileError(
                    f"path {path_str!r} matched no values in column {name!r} "
                    f"(checked first {_PROBE_ROWS} rows); is the path correct?"
                )
            select_parts.append(f"{expr} AS {ident}")
            applied.append((name, path_str))

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
                f"COPY (SELECT {select_list} FROM {reader}) "
                f"TO {quote_literal(str(tmp_path))} ({copy_options(fmt)})"
            )
            os.replace(tmp_path, path)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise
    finally:
        con.close()

    return fmt, applied


def resolve_files(pattern: str) -> list[Path]:
    """Expand a path-or-wildcard into a sorted list of existing files."""
    matches = sorted(glob.glob(pattern, recursive=True))
    files = [Path(m) for m in matches if os.path.isfile(m)]
    if not files:
        if glob.has_magic(pattern):
            raise SystemExit(f"error: no files match pattern: {pattern}")
        raise SystemExit(f"error: no such file: {pattern}")
    return files


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Reduce JSON-valued column(s) to a nested value in "
            "parquet/csv/jsonl file(s) in place, preserving column order."
        ),
    )
    parser.add_argument(
        "file",
        help="a file path or quoted wildcard pattern, e.g. '000*.parquet'",
    )
    parser.add_argument(
        "extractions",
        help=(
            "semicolon-separated column=path pairs, e.g. "
            "'conversations=0.value;meta=prompt'"
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

    extractions = parse_extractions(args.extractions)
    if not extractions:
        raise SystemExit("error: no extractions given")

    files = resolve_files(args.file)
    workers = max(1, min(args.workers, len(files)))

    ok = 0
    failures: list[tuple[Path, str]] = []
    # Each file gets its own DuckDB connection inside process_file, so the work
    # is thread-safe; we only print from this (the main) thread to keep output
    # lines from interleaving.
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(process_file, path, extractions, args.format): path
            for path in files
        }
        for future in as_completed(futures):
            path = futures[future]
            try:
                fmt, applied = future.result()
            except Exception as exc:  # FileError or a DuckDB read/write error
                failures.append((path, str(exc)))
                print(f"  SKIP {path}: {exc}", file=sys.stderr)
                continue
            ok += 1
            mapping = ", ".join(f"{col} <- {p}" for col, p in applied)
            print(f"  {path} [{fmt}]: reduced {mapping}")

    if len(files) > 1 or failures:
        pairs = "; ".join(f"{col}={p}" for col, p in extractions)
        summary = f"Done: {ok}/{len(files)} file(s) reduced, extractions: {pairs}"
        if failures:
            summary += f"; {len(failures)} skipped"
        print(summary, file=sys.stderr)

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
