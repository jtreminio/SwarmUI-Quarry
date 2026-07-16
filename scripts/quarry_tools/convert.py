"""`quarry convert` subcommands: change a dataset's on-disk representation.

jsonl / csv / append -- carried over from json_to_jsonl.py, to_csv.py and
append_files.py. to-lance now lives in the lance module as `quarry lance convert`
and is re-registered here as an alias. Heavy libraries (duckdb, lance) are
imported lazily inside the command functions; jsonl and csv are pure stdlib.
"""

from __future__ import annotations

import argparse
import csv as _csv
import json
import sys
from pathlib import Path

from . import lance as _lance
from .common import (
    EXT_FORMAT,
    atomic_output,
    copy_options,
    detect_format,
    format_parent,
    quote_literal,
    resolve_files,
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

    _lance.register_convert(subparsers, "to-lance", "quarry convert to-lance",
                            alias_of="quarry lance convert")
