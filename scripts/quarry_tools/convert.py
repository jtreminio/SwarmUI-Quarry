"""`quarry convert` subcommands: change a dataset's on-disk representation.

jsonl / csv / append / to-lance -- carried over from json_to_jsonl.py, to_csv.py,
append_files.py and to_lancedb.py. Heavy libraries (duckdb, lance) are imported
lazily inside the command functions; jsonl and csv are pure stdlib.
"""

from __future__ import annotations

import argparse
import csv as _csv
import json
import sys
from pathlib import Path

from .common import (
    EXT_FORMAT,
    as_pool_results,
    atomic_output,
    copy_options,
    detect_format,
    format_parent,
    quote_ident,
    quote_literal,
    resolve_files,
    workers_parent,
)

# ===========================================================================
# convert jsonl
# ===========================================================================

_JSONL_DESC = """\
Convert a JSON file (an array of objects) to JSONL -- one object per line.

A pretty-printed JSON array like

    [
      { "id": 1, ... },
      { "id": 2, ... }
    ]

becomes newline-delimited JSON (JSONL / NDJSON):

    {"id":1,...}
    {"id":2,...}

Each array element is written verbatim onto its own compact line -- the object's
own keys and their order are preserved. A top-level single object is written as
one line. Output is written to a temp file first, then atomically moved into place.

Usage:
    quarry convert jsonl <file.json> [-o out.jsonl]
    quarry convert jsonl DamarJati.mj-disney.json     # -> DamarJati.mj-disney.jsonl
    quarry convert jsonl data.json -o /tmp/data.jsonl
"""


def cmd_jsonl(args) -> int:
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

    out_path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with atomic_output(out_path) as tmp_path:
        with tmp_path.open("w", encoding="utf-8") as out:
            for record in records:
                out.write(
                    json.dumps(record, ensure_ascii=args.ascii, separators=(",", ":"))
                )
                out.write("\n")
                count += 1

    print(f"Wrote {count} record(s) to {out_path}")
    return 0


# ===========================================================================
# convert csv
# ===========================================================================

_CSV_DESC = """\
Convert a simple TXT file (one value per line) into a single-column CSV.

The output is written next to the input with a .csv extension.

Usage:
    quarry convert csv FILENAME.txt COLUMN
"""


def cmd_csv(args) -> int:
    txt_path = Path(args.file)
    column = args.column

    if not txt_path.is_file():
        print(f"Error: file not found: {txt_path}", file=sys.stderr)
        return 1

    csv_path = txt_path.with_suffix(".csv")

    with txt_path.open("r", encoding="utf-8") as src, csv_path.open(
        "w", newline="", encoding="utf-8"
    ) as dst:
        writer = _csv.writer(dst)
        writer.writerow([column])
        for line in src:
            writer.writerow([line.rstrip("\n")])

    print(f"Wrote {csv_path}")
    return 0


# ===========================================================================
# convert append
# ===========================================================================

_APPEND_DESC = """\
Append (row-stack) two or more Parquet/CSV/JSONL files onto a master.

The first file is the master; every other file's rows are appended to it. By
default the combined result is written back to the master file in place (in the
master's format). Inputs may mix formats freely.

Columns are aligned by name (DuckDB UNION ALL BY NAME): a column missing from some
file is filled with NULL for that file's rows. Use --strict to require every file
to have the exact same set of columns.

Inputs may be plain paths and/or wildcard patterns (*, ?, [...], **); quote
patterns so the shell passes them through. All matches are flattened, in argument
order, into one de-duplicated list -- the first file is the master and the rest
are appended onto it.

Usage:
    quarry convert append 'dir/*.parquet'                    # first match = master
    quarry convert append master.parquet 'shard_*.parquet'   # explicit master
    quarry convert append master.parquet jan.parquet feb.parquet
    quarry convert append base.csv extra.jsonl -o combined.parquet
    quarry convert append a.csv b.csv c.csv --strict
"""

_APPEND_FORMATS = ("parquet", "csv", "jsonl")


def _append_detect(path: Path, override: str | None = None) -> str:
    return detect_format(
        path, override, ext_map=EXT_FORMAT, formats=_APPEND_FORMATS,
        hint="parquet|csv|jsonl", include_path=True,
    )


def _append_reader(path: Path) -> str:
    """Build a DuckDB reader call for a single file based on its format."""
    fmt = _append_detect(path)
    lit = quote_literal(str(path))
    if fmt == "parquet":
        return f"read_parquet({lit})"
    if fmt == "csv":
        return f"read_csv_auto({lit})"
    return f"read_json({lit}, format='newline_delimited')"


def _append_reader_multi(fmt: str, paths: list[Path]) -> str:
    """A single multi-file reader over many same-format files (streamed)."""
    lst = "[" + ", ".join(quote_literal(str(p)) for p in paths) + "]"
    if fmt == "parquet":
        return f"read_parquet({lst}, union_by_name=true)"
    if fmt == "csv":
        return f"read_csv_auto({lst}, union_by_name=true)"
    return f"read_json({lst}, format='newline_delimited', union_by_name=true)"


def cmd_append(args) -> int:
    import duckdb

    def columns_of(con, path: Path) -> list[str]:
        rows = con.execute(f"DESCRIBE SELECT * FROM {_append_reader(path)}").fetchall()
        return [r[0] for r in rows]

    # Expand every path/pattern in order into one de-duplicated file list.
    seen: set[Path] = set()
    files: list[Path] = []
    for pattern in args.inputs:
        for path in resolve_files(pattern):
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
    out_fmt = _append_detect(dest, args.format)

    con = duckdb.connect()
    try:
        if args.strict:
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
        # multi-file reader, then stack the runs. Order is preserved.
        runs: list[tuple[str, list[Path]]] = []
        for path in all_inputs:
            fmt = _append_detect(path, None)
            if runs and runs[-1][0] == fmt:
                runs[-1][1].append(path)
            else:
                runs.append((fmt, [path]))

        select_sql = " UNION ALL BY NAME ".join(
            f"SELECT * FROM {_append_reader_multi(fmt, paths)}" for fmt, paths in runs
        )

        with atomic_output(dest) as tmp_path:
            result = con.execute(
                f"COPY ({select_sql}) TO {quote_literal(str(tmp_path))} "
                f"({copy_options(out_fmt)})"
            ).fetchone()
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


# ===========================================================================
# convert to-lance
# ===========================================================================

_TOLANCE_DESC = """\
Convert CSV / JSONL / Parquet file(s) into standalone Lance dataset(s).

The input is read with DuckDB as a stream of Arrow record batches and written
straight into a Lance dataset, so even large files convert without loading
everything into memory.

Rows whose prompt column is empty or whitespace-only are dropped during conversion
(see --prompt-column), so the dataset holds only usable wildcard picks. This lets
the Quarry extension pick a random row with a plain LIMIT/OFFSET (a native O(1)
Lance seek) instead of a non-empty WHERE filter.

Each input file becomes its own single <name>.lance dataset directory.

The input may be a single file or a directory:
  * a file      -> one .lance dataset. -o is the output dataset path
                   (default: <input>.lance next to the input).
  * a directory -> every convertible file in it (non-recursive) becomes its own
                   <stem>.lance dataset. -o is the output directory
                   (default: the input directory itself).

In directory mode the files are converted concurrently (16 at a time by default,
see -w); each goes through its own DuckDB connection and writes its own dataset.

Usage:
    quarry convert to-lance <file-or-dir> [-o OUT] [--mode MODE] [-w N]
    quarry convert to-lance data.parquet
    quarry convert to-lance prompts.jsonl -o ./prompts.lance
    quarry convert to-lance ./shards/                 # one .lance per file
    quarry convert to-lance ./shards/ -o ./lance/     # into ./lance/
    quarry convert to-lance more.parquet -o ./prompts.lance --mode append

Modes: create (default, fails if the dataset exists), overwrite, append.
"""

_TOLANCE_FORMATS = ("parquet", "csv", "jsonl")

# Conventionally named text columns, in preference order. Mirrors the extension's
# PromptColumnResolver so the column we strip blanks from is the one it later reads.
_PREFERRED_PROMPT_COLUMNS = ("prompt", "text", "caption", "description", "value")


def _tolance_reader(fmt: str, *, parallel: bool = True) -> str:
    """DuckDB reader call with a ``?`` placeholder; ``parallel`` affects only CSV."""
    if fmt == "parquet":
        return "read_parquet(?)"
    if fmt == "csv":
        return "read_csv_auto(?)" if parallel else "read_csv_auto(?, parallel=false)"
    return "read_json(?, format='newline_delimited')"


def _resolve_prompt_column(columns: list[str], override: str | None) -> str | None:
    if override:
        for col in columns:
            if col.lower() == override.lower():
                return col
        raise SystemExit(
            f"error: --prompt-column {override!r} not found; "
            f"columns: {', '.join(columns) or '(none)'}"
        )
    by_lower = {col.lower(): col for col in columns}
    for preferred in _PREFERRED_PROMPT_COLUMNS:
        if preferred in by_lower:
            return by_lower[preferred]
    return columns[0] if columns else None


def _plan_jobs(path, output, override_format):
    if path.is_file():
        out = Path(output) if output else path.with_suffix(".lance")
        return [(path, out)]

    if path.is_dir():
        files = sorted(p for p in path.iterdir() if p.is_file())
        if override_format:
            srcs = files
        else:
            srcs = [p for p in files if p.suffix.lower() in EXT_FORMAT]
        if not srcs:
            raise SystemExit(
                f"error: no convertible files found in {path} "
                f"(looked for: {', '.join(sorted(EXT_FORMAT))}; "
                "pass --format to process other extensions)"
            )
        out_dir = Path(output) if output else path
        out_dir.mkdir(parents=True, exist_ok=True)
        jobs = [(p, out_dir / f"{p.stem}.lance") for p in srcs]
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


def _stream_to_lance(src, fmt, out_path, mode, batch_rows, prompt_column, parallel):
    import duckdb
    import lance

    con = duckdb.connect()
    try:
        reader_call = _tolance_reader(fmt, parallel=parallel)
        columns = [
            row[0]
            for row in con.execute(
                f"DESCRIBE SELECT * FROM {reader_call}", [str(src)]
            ).fetchall()
        ]
        col = _resolve_prompt_column(columns, prompt_column)
        select_sql = (
            f"SELECT * FROM {reader_call} "
            f"WHERE length(trim(CAST({quote_ident(col)} AS VARCHAR))) > 0"
            if col is not None
            else f"SELECT * FROM {reader_call}"
        )
        reader = con.execute(select_sql, [str(src)]).to_arrow_reader(batch_rows)
        ds = lance.write_dataset(reader, str(out_path), mode=mode)
        return ds.count_rows(), list(ds.schema.names)
    finally:
        con.close()


def _convert_one(src, fmt, out_path, mode, batch_rows, prompt_column):
    import shutil

    existed_before = out_path.exists()
    try:
        return _stream_to_lance(
            src, fmt, out_path, mode, batch_rows, prompt_column, parallel=True
        )
    except Exception as exc:
        # DuckDB's multi-threaded CSV reader can't do a full read of some files
        # (quoted fields spanning newlines, etc.); retry once single-threaded.
        if fmt != "csv" or "Parallel CSV Reader" not in str(exc):
            raise
        if mode == "create" and not existed_before and out_path.exists():
            shutil.rmtree(out_path, ignore_errors=True)
        return _stream_to_lance(
            src, fmt, out_path, mode, batch_rows, prompt_column, parallel=False
        )


def cmd_to_lance(args) -> int:
    path = Path(args.input)
    if not path.exists():
        raise SystemExit(f"error: no such file or directory: {path}")

    jobs = _plan_jobs(path, args.output, args.format)
    single = len(jobs) == 1
    planned = [
        (
            src,
            detect_format(
                src, args.format, ext_map=EXT_FORMAT, formats=_TOLANCE_FORMATS,
                hint="parquet|csv|jsonl",
            ),
            out,
        )
        for src, out in jobs
    ]

    converted = 0
    failed = 0
    for item, result, exc in as_pool_results(
        lambda t: _convert_one(
            t[0], t[1], t[2], args.mode, args.batch_rows, args.prompt_column
        ),
        planned,
        args.workers,
    ):
        src, fmt, out_path = item
        if exc is not None:
            failed += 1
            print(
                f"FAIL {src} [{fmt}] -> {str(out_path)!r}: {exc}", file=sys.stderr
            )
            continue
        rows, columns = result
        converted += 1
        line = f"{src} [{fmt}] -> {str(out_path)!r} (mode={args.mode}; {rows} row(s))"
        if single:
            line += f"\nColumns: {', '.join(columns)}"
        print(line)

    if not single:
        print(f"\nConverted {converted}/{len(jobs)} file(s); {failed} failed.")
    return 1 if failed else 0


# ===========================================================================
# registration
# ===========================================================================


def register(subparsers) -> None:
    raw = argparse.RawDescriptionHelpFormatter

    p = subparsers.add_parser(
        "jsonl", help="convert a JSON array file to JSONL (one object per line)",
        description=_JSONL_DESC, formatter_class=raw,
    )
    p.add_argument("input", help="path to the source .json file")
    p.add_argument(
        "-o", "--output", default=None,
        help="output path (default: the input with a .jsonl extension)",
    )
    p.add_argument(
        "--ascii", action="store_true",
        help="escape non-ASCII characters (default: keep them as UTF-8)",
    )
    p.set_defaults(func=cmd_jsonl)

    p = subparsers.add_parser(
        "csv", help="convert a one-value-per-line TXT file to a single-column CSV",
        description=_CSV_DESC, formatter_class=raw,
    )
    p.add_argument("file", help="path to the source .txt file")
    p.add_argument("column", help="the name for the single output column")
    p.set_defaults(func=cmd_csv)

    p = subparsers.add_parser(
        "append", help="append (row-stack) parquet/csv/jsonl files onto a master",
        description=_APPEND_DESC, formatter_class=raw,
        parents=[
            format_parent(
                _APPEND_FORMATS,
                "override the output format (default: inferred from the destination)",
            )
        ],
    )
    p.add_argument(
        "inputs", nargs="+", metavar="file",
        help="files and/or quoted wildcard pattern(s); the first matched file is "
        "the master and the rest are appended onto it",
    )
    p.add_argument(
        "-o", "--output", default=None,
        help="write the result here instead of overwriting the master in place",
    )
    p.add_argument(
        "--strict", action="store_true",
        help="require every file to have the exact same set of columns",
    )
    p.set_defaults(func=cmd_append)

    p = subparsers.add_parser(
        "to-lance", help="convert csv/jsonl/parquet file(s) into .lance dataset(s)",
        description=_TOLANCE_DESC, formatter_class=raw,
        parents=[
            format_parent(
                _TOLANCE_FORMATS,
                "override the input format instead of inferring it from the extension",
            ),
            workers_parent(
                16,
                "how many files to convert concurrently in directory mode "
                "(default: 16). Each conversion is itself multi-threaded, so lower "
                "this for very large or memory-heavy inputs",
            ),
        ],
    )
    p.add_argument(
        "input", help="a .csv/.jsonl/.parquet file, or a directory of such files"
    )
    p.add_argument(
        "-o", "--output", default=None,
        help="output .lance dataset path (file input; default: <input>.lance), "
        "or output directory (directory input; default: the input directory)",
    )
    p.add_argument(
        "--mode", choices=("create", "overwrite", "append"), default="create",
        help="create (default; fail if it exists), overwrite, or append",
    )
    p.add_argument(
        "--prompt-column", default=None,
        help="column to drop blank/whitespace rows on (the prompt text column). "
        "Default: the first of prompt/text/caption/description/value present, else "
        "the first column -- mirroring how the Quarry extension resolves it",
    )
    p.add_argument(
        "--batch-rows", type=int, default=50_000,
        help="rows per streamed Arrow batch (default: 50000)",
    )
    p.set_defaults(func=cmd_to_lance)
