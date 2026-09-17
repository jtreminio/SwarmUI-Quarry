"""`quarry browse` -- browse a dataset in the terminal with VisiData.

Carried over from browse.py. duckdb / lance / pyarrow are imported lazily inside
the helpers (as the original did); VisiData is invoked as the external `vd` binary.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

_BROWSE_DESC = """\
Browse a parquet / csv / tsv / json / jsonl / sqlite / lance dataset in the terminal.

Thin wrapper around VisiData: a terminal spreadsheet with native mouse-wheel
scrolling for rows and arrow-key / hjkl navigation across columns. VisiData reads
every file format below, so this just picks the correct loader and guards against
giant BLOB columns in parquet files (e.g. image datasets) that would otherwise
load gigabytes into memory.

Usage:
    quarry browse FILE
    quarry browse DATASET.lance

Navigation once open (VisiData):
    mouse wheel / j / k / arrows   scroll rows
    h / l / arrows                 move across columns
    /                              search in a column
    [ / ]                          sort by current column
    z then Enter                   open current cell (lists, objects, text)
    Enter                          open current row / page
                                   text views wrap long lines automatically
    q                              go back one screen (quit on last screen)
    g then q                       quit all screens
"""

# extension -> VisiData loader name
LOADERS = {
    ".parquet": "parquet",
    ".csv": "csv",
    ".tsv": "tsv",
    ".json": "json",
    ".jsonl": "jsonl",
    ".ndjson": "jsonl",
    ".sqlite": "sqlite",
    ".sqlite3": "sqlite",
    ".db": "sqlite",
    ".lance": "lance",  # a Lance dataset directory (streamed to temp parquet)
}


def _describe(path):
    """Return [(column_name, column_type), ...] for a parquet file via DuckDB."""
    import duckdb

    con = duckdb.connect()
    rows = con.sql(
        "SELECT column_name, column_type "
        "FROM (DESCRIBE SELECT * FROM read_parquet(?))",
        params=[str(path)],
    ).fetchall()
    return [(name, dtype) for name, dtype in rows]


def _blob_columns(path):
    """Return names of columns whose type contains BLOB (top-level or nested)."""
    return [name for name, dtype in _describe(path) if "BLOB" in dtype.upper()]


def _make_blobless_view(path, blob_cols):
    """Write a temp parquet where each BLOB column becomes its byte length."""
    import duckdb

    con = duckdb.connect()
    schema = _describe(path)
    blob_set = set(blob_cols)

    def project(col, dtype):
        q = f'"{col}"'
        if col not in blob_set:
            return q
        up = dtype.upper()
        if up.startswith("STRUCT") and "BYTES BLOB" in up:
            return f"octet_length({q}.bytes) AS {q}"
        return f"octet_length({q}) AS {q}"

    select = ", ".join(project(c, t) for c, t in schema)
    tmp = tempfile.NamedTemporaryFile(suffix=".parquet", delete=False)
    tmp.close()
    con.sql(
        f"COPY (SELECT {select} FROM read_parquet(?)) "
        f"TO '{tmp.name}' (FORMAT parquet)",
        params=[str(path)],
    )
    return Path(tmp.name)


def _lance_ident(name):
    """Backtick-quote a Lance/DataFusion identifier (Lance requires backticks)."""
    return "`" + name.replace("`", "``") + "`"


def _lance_blob_projection(field):
    """Return a scanner expression that replaces a BLOB field with its byte size."""
    import pyarrow as pa

    ident = _lance_ident(field.name)
    t = field.type
    if (
        pa.types.is_binary(t)
        or pa.types.is_large_binary(t)
        or pa.types.is_fixed_size_binary(t)
    ):
        return f"octet_length(encode({ident}, 'hex')) / 2"
    if pa.types.is_struct(t):
        sub = {f.name for f in t}
        if "bytes" in sub:
            return f"octet_length(encode({ident}.{_lance_ident('bytes')}, 'hex')) / 2"
    return None


def _make_lance_parquet(path):
    """Stream a Lance dataset to a temp parquet, shrinking BLOB columns to sizes."""
    import lance
    import pyarrow.parquet as pq
    from .storage import logical_reader

    ds = lance.dataset(str(path))
    logical = logical_reader(ds, path)
    blob_cols = []
    columns = {}
    for field in logical.schema:
        expr = _lance_blob_projection(field)
        if expr is not None:
            blob_cols.append(field.name)
            columns[field.name] = expr
    logical.close()

    reader = logical_reader(ds, path, batch_rows=8192, projections=columns)
    tmp = tempfile.NamedTemporaryFile(suffix=".parquet", delete=False)
    tmp.close()
    try:
        with pq.ParquetWriter(tmp.name, reader.schema) as writer:
            for batch in reader:
                writer.write_batch(batch)
    except BaseException:
        Path(tmp.name).unlink(missing_ok=True)
        raise
    finally:
        reader.close()
    return Path(tmp.name), blob_cols


def cmd_browse(args) -> int:
    if args.file is None:
        args._help_parser.print_help()
        return 0

    path = Path(args.file).expanduser()

    loader = LOADERS.get(path.suffix.lower())
    if loader is None:
        print(
            f"Error: unsupported extension '{path.suffix}'. "
            f"Supported: {', '.join(sorted(LOADERS))}",
            file=sys.stderr,
        )
        return 2

    if loader == "lance":
        if not path.is_dir():
            print(f"Error: Lance dataset not found: {path}", file=sys.stderr)
            return 1
    elif not path.is_file():
        print(f"Error: file not found: {path}", file=sys.stderr)
        return 1

    open_path = path
    tmp_path = None
    if loader == "lance":
        tmp_path, cols = _make_lance_parquet(path)
        open_path = tmp_path
        loader = "parquet"  # VisiData browses the streamed temp parquet
        if cols:
            print(
                f"Note: {len(cols)} BLOB column(s) ({', '.join(cols)}) shown as "
                "byte sizes to avoid loading raw bytes.",
                file=sys.stderr,
            )
    elif loader == "parquet":
        cols = _blob_columns(path)
        if cols:
            print(
                f"Note: {len(cols)} BLOB column(s) ({', '.join(cols)}) shown as "
                "byte sizes to avoid loading raw bytes.",
                file=sys.stderr,
            )
            tmp_path = _make_blobless_view(path, cols)
            open_path = tmp_path

    try:
        print(
            "VisiData navigation:\n"
            "  q               Go back one screen (quit on the last screen).\n"
            "  z then Enter    Open the current cell's contents (list, object, or text).\n"
            "  Enter           Open the current row / page.\n"
            "  For pages: highlight the pages cell, press z then Enter, then Enter on a page.\n"
            "  Text views wrap long lines automatically.\n"
            "  g then q        Quit all screens.",
            file=sys.stderr,
            flush=True,
        )
        # Hand off to VisiData; it inherits the tty so scrolling works.
        return subprocess.call(["vd", "--wrap", "-f", loader, str(open_path)])
    except FileNotFoundError:
        print(
            "Error: 'vd' (VisiData) not found. Run it via the project env "
            "(uv run ./quarry browse ...).",
            file=sys.stderr,
        )
        return 127
    finally:
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def register(subparsers) -> None:
    p = subparsers.add_parser(
        "browse", help="browse a parquet/csv/tsv/json/jsonl/sqlite/lance file",
        description=_BROWSE_DESC,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("file", nargs="?", help="path to the data file")
    p.set_defaults(func=cmd_browse, _help_parser=p)
