#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["duckdb>=1.0", "pylance"]
# ///
"""Convert CSV / JSONL / Parquet file(s) into standalone Lance dataset(s).

The input is read with DuckDB (which handles all three formats) as a *stream* of
Arrow record batches and written straight into a Lance dataset, so even large
files convert without loading everything into memory.

Rows whose prompt column is empty or whitespace-only are dropped during conversion
(see ``--prompt-column``), so the dataset holds only usable wildcard picks. This lets
the Quarry extension pick a random row with a plain ``LIMIT/OFFSET`` -- a native O(1)
Lance seek -- instead of a non-empty ``WHERE`` filter, which would defeat that pushdown
and force a full scan on every single prompt.

Each input file becomes its own single ``<name>.lance`` dataset directory and
nothing else. This writes the dataset directly with ``pylance`` rather than
through ``lancedb``, so there is no surrounding ``.lancedb`` database directory
and no database-level ``__manifest`` catalog -- just the ``.lance`` table itself.
(The ``_versions`` and ``_transactions`` subdirectories inside it are the
dataset's own metadata and are an inherent part of every Lance table.)

The result is a normal Lance dataset: open it with ``lance.dataset(path)``, or
point LanceDB / DuckDB at the ``.lance`` directory directly.

The input may be a single file or a directory:
  * a file      -> one ``.lance`` dataset. ``-o`` is the output dataset path
                   (default: ``<input>.lance`` next to the input).
  * a directory -> every convertible file in it (non-recursive) becomes its own
                   ``<stem>.lance`` dataset. ``-o`` is the output *directory*
                   (default: the input directory itself).
In directory mode, files whose extension isn't a recognized data format are
skipped unless ``--format`` is given (which then applies to every file).

In directory mode the files are converted concurrently (16 at a time by default,
see ``-w``); each goes through its own DuckDB connection and writes its own
dataset, so the conversions are independent and a failure on one is reported
while the rest keep going. Each conversion is itself multi-threaded, so lower
``-w`` for very large or memory-heavy inputs.

Usage:
    python to_lancedb.py <file-or-dir> [-o OUT] [--mode MODE] [-w N]
    python to_lancedb.py data.parquet
    python to_lancedb.py prompts.jsonl -o ./prompts.lance
    python to_lancedb.py ./shards/                 # one .lance per file, in ./shards/
    python to_lancedb.py ./shards/ -o ./lance/     # one .lance per file, in ./lance/
    python to_lancedb.py ./shards/ -w 4            # 4 files at a time
    python to_lancedb.py more.parquet -o ./prompts.lance --mode append

Modes: create (default, fails if the dataset exists), overwrite, append.

Run with the project venv:
    .venv/bin/python scripts/to_lancedb.py data.parquet

or standalone with uv (deps declared inline above):
    uv run scripts/to_lancedb.py data.parquet
"""

from __future__ import annotations

import argparse
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import duckdb
import lance

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


def reader_sql(fmt: str) -> str:
    """DuckDB reader call with a ``?`` placeholder for the file path."""
    if fmt == "parquet":
        return "read_parquet(?)"
    if fmt == "csv":
        return "read_csv_auto(?)"
    return "read_json(?, format='newline_delimited')"


# Conventionally named text columns, in preference order. Mirrors the extension's PromptColumnResolver so the
# column we strip blanks from is the same one it will later read prompts from.
_PREFERRED_PROMPT_COLUMNS = ("prompt", "text", "caption", "description", "value")


def quote_ident(name: str) -> str:
    """Double-quote a SQL identifier, escaping embedded double quotes."""
    return '"' + name.replace('"', '""') + '"'


def resolve_prompt_column(columns: list[str], override: str | None) -> str | None:
    """Pick the column whose blank rows should be dropped, mirroring the extension's PromptColumnResolver: an
    explicit ``override`` if given, else the first conventionally named text column, else the first column.
    Returns ``None`` only for an empty schema. Matching is case-insensitive; the dataset's own casing wins."""
    if override:
        for col in columns:
            if col.lower() == override.lower():
                return col
        raise SystemExit(
            f"error: --prompt-column {override!r} not found; columns: {', '.join(columns) or '(none)'}"
        )
    by_lower = {col.lower(): col for col in columns}
    for preferred in _PREFERRED_PROMPT_COLUMNS:
        if preferred in by_lower:
            return by_lower[preferred]
    return columns[0] if columns else None


def plan_jobs(path: Path, output: str | None, override_format: str | None) -> list[tuple[Path, Path]]:
    """Resolve the input path into a list of (source file, output .lance) jobs."""
    if path.is_file():
        out = Path(output) if output else path.with_suffix(".lance")
        return [(path, out)]

    if path.is_dir():
        files = sorted(p for p in path.iterdir() if p.is_file())
        if override_format:
            srcs = files
        else:
            srcs = [p for p in files if p.suffix.lower() in _EXT_FORMAT]
        if not srcs:
            raise SystemExit(
                f"error: no convertible files found in {path} "
                f"(looked for: {', '.join(sorted(_EXT_FORMAT))}; "
                "pass --format to process other extensions)"
            )
        out_dir = Path(output) if output else path
        out_dir.mkdir(parents=True, exist_ok=True)
        jobs = [(p, out_dir / f"{p.stem}.lance") for p in srcs]
        # Two different inputs can share a stem (e.g. a.parquet and a.csv) and so
        # map to the same <stem>.lance. Converting them concurrently would write
        # one Lance dataset from multiple threads and corrupt it -- refuse up front.
        first_for: dict[Path, Path] = {}
        for src, out in jobs:
            if out in first_for:
                raise SystemExit(
                    f"error: {src} and {first_for[out]} both map to {out}; "
                    f"rename one or convert them separately"
                )
            first_for[out] = src
        return jobs

    raise SystemExit(f"error: no such file or directory: {path}")


def convert_one(src: Path, fmt: str, out_path: Path, mode: str, batch_rows: int, prompt_column: str | None):
    """Stream one file into a Lance dataset; return (rows, column names).

    Rows whose prompt column is empty/whitespace are dropped here, so the dataset holds only usable wildcard
    picks. ``length(trim(CAST(col AS VARCHAR))) > 0`` matches the test the extension used to apply at query
    time (a NULL or all-whitespace value is excluded); doing it at ingest lets the extension select rows with a
    pushed-down ``LIMIT/OFFSET`` instead. An empty schema (no resolvable column) keeps every row.

    Opens its own DuckDB connection so it is safe to run from a worker thread.
    """
    con = duckdb.connect()
    try:
        reader_call = reader_sql(fmt)
        columns = [
            row[0]
            for row in con.execute(
                f"DESCRIBE SELECT * FROM {reader_call}", [str(src)]
            ).fetchall()
        ]
        col = resolve_prompt_column(columns, prompt_column)
        select_sql = (
            f"SELECT * FROM {reader_call} "
            f"WHERE length(trim(CAST({quote_ident(col)} AS VARCHAR))) > 0"
            if col is not None
            else f"SELECT * FROM {reader_call}"
        )
        reader = con.execute(select_sql, [str(src)]).to_arrow_reader(batch_rows)
        # lance.write_dataset modes map 1:1 to ours: "create" raises if the
        # dataset already exists, "overwrite" replaces it, "append" adds to it
        # (creating it if missing). write_dataset fully drains the reader before
        # it returns, so closing the connection afterward is safe.
        ds = lance.write_dataset(reader, str(out_path), mode=mode)
        return ds.count_rows(), list(ds.schema.names)
    finally:
        con.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Convert csv/jsonl/parquet file(s) into standalone .lance dataset(s).",
    )
    parser.add_argument(
        "input",
        help="a .csv/.jsonl/.parquet file, or a directory of such files",
    )
    parser.add_argument(
        "-o",
        "--output",
        default=None,
        help=(
            "output .lance dataset path (file input; default: <input>.lance), "
            "or output directory (directory input; default: the input directory)"
        ),
    )
    parser.add_argument(
        "--mode",
        choices=("create", "overwrite", "append"),
        default="create",
        help="create (default; fail if it exists), overwrite, or append",
    )
    parser.add_argument(
        "--format",
        choices=_FORMATS,
        default=None,
        help="override the input format instead of inferring it from the extension",
    )
    parser.add_argument(
        "--prompt-column",
        default=None,
        help=(
            "column to drop blank/whitespace rows on (the prompt text column). Default: the first of "
            "prompt/text/caption/description/value present, else the first column -- mirroring how the "
            "Quarry extension resolves the prompt column"
        ),
    )
    parser.add_argument(
        "--batch-rows",
        type=int,
        default=50_000,
        help="rows per streamed Arrow batch (default: 50000)",
    )
    parser.add_argument(
        "-w",
        "--workers",
        type=int,
        default=16,
        help=(
            "how many files to convert concurrently in directory mode "
            "(default: 16). Each conversion is itself multi-threaded, so lower "
            "this for very large or memory-heavy inputs"
        ),
    )
    args = parser.parse_args(argv)

    path = Path(args.input)
    if not path.exists():
        raise SystemExit(f"error: no such file or directory: {path}")

    jobs = plan_jobs(path, args.output, args.format)
    single = len(jobs) == 1
    # Resolve every input's format up front so a bad extension fails before any
    # conversion starts, rather than mid-run inside a worker thread.
    planned = [(src, detect_format(src, args.format), out) for src, out in jobs]
    workers = max(1, min(args.workers, len(planned)))

    converted = 0
    failed = 0
    # Each conversion opens its own DuckDB connection inside convert_one, so the
    # work is thread-safe; we only print from this (the main) thread to keep
    # output lines from interleaving.
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(
                convert_one, src, fmt, out_path, args.mode, args.batch_rows, args.prompt_column
            ): (src, fmt, out_path)
            for src, fmt, out_path in planned
        }
        for future in as_completed(futures):
            src, fmt, out_path = futures[future]
            try:
                rows, columns = future.result()
            except Exception as exc:  # keep going through the rest of a directory
                failed += 1
                print(f"FAIL {src} [{fmt}] -> {str(out_path)!r}: {exc}", file=sys.stderr)
                continue
            converted += 1
            line = f"{src} [{fmt}] -> {str(out_path)!r} (mode={args.mode}; {rows} row(s))"
            if single:
                line += f"\nColumns: {', '.join(columns)}"
            print(line)

    if not single:
        print(f"\nConverted {converted}/{len(jobs)} file(s); {failed} failed.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
