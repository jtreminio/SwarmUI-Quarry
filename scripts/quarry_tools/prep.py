"""Interactive selection, conversion, and preparation of a single dataset."""

from __future__ import annotations

import argparse
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

from . import lance as lance_tools
from .common import EXT_FORMAT_SHOW, FileError, detect_format, format_parent, quote_literal, read_relation_sql

_FORMATS = ("parquet", "csv", "jsonl", "json", "lance")


def plan_columns(existing: list[str], raw: str) -> list[tuple[str, str]]:
    """Resolve an ordered selection; bare names keep their original spelling."""
    raw = raw.strip()
    # Unlike shell arguments, input() retains quotes pasted around a selection.
    if len(raw) >= 2 and raw[0] in ("'", '"') and raw[-1] == raw[0]:
        raw = raw[1:-1]
    by_lower: dict[str, list[str]] = {}
    for name in existing:
        by_lower.setdefault(name.lower(), []).append(name)
    selected: list[tuple[str, str]] = []
    sources: set[str] = set()
    targets: set[str] = set()
    for chunk in raw.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        old, sep, new = chunk.partition("=")
        old, new = old.strip(), new.strip()
        if not old or (sep and not new):
            raise FileError(f"bad selection {chunk!r}; expected 'column' or 'old=new'")
        matches = by_lower.get(old.lower(), [])
        if not matches:
            raise FileError(f"column {old!r} not found (available: {', '.join(existing)})")
        if len(matches) != 1:
            raise FileError(f"column {old!r} is ambiguous (names differ only by case)")
        source = matches[0]
        target = new if sep else source
        if source.lower() in sources:
            raise FileError(f"column {old!r} selected more than once")
        if target.lower() in targets:
            raise FileError(f"duplicate output column name: {target!r}")
        sources.add(source.lower())
        targets.add(target.lower())
        selected.append((source, target))
    if not selected:
        raise FileError("select at least one column")
    return selected


@contextmanager
def open_source(path: Path, fmt: str, batch_rows: int):
    """Expose a schema, row count, and lazy batches while keeping the reader open."""
    if fmt == "lance":
        import lance

        ds = lance.dataset(str(path))
        yield ds.schema, ds.count_rows(), lambda names: ds.scanner(
            columns=names, batch_size=batch_rows
        ).to_batches()
        return

    import duckdb

    con = duckdb.connect()
    try:
        # Serial CSV reading also handles quoted fields spanning multiple lines.
        source = quote_literal(str(path))
        reader = (
            f"read_csv_auto({source}, parallel=false)"
            if fmt == "csv" else read_relation_sql(fmt, source)
        )
        # DuckDB's sql(..., params=...) materializes the result immediately.
        # A quoted path keeps this relation lazy so projection and batching
        # apply before the source data is read.
        relation = con.sql(f"SELECT * FROM {reader}")
        schema = relation.limit(0).to_arrow_reader(batch_rows).schema

        def batches(names):
            from .common import quote_ident

            return relation.project(
                ", ".join(quote_ident(name) for name in names)
            ).to_arrow_reader(batch_rows)

        yield schema, relation.aggregate("count(*)").fetchone()[0], batches
    finally:
        con.close()


def selected_reader(schema, batches, selected):
    """Rename and flatten streamed batches without moving selected columns."""
    import pyarrow as pa

    fields = []
    flattened = []
    for source, target in selected:
        field = schema.field(source)
        flatten = lance_tools.is_list_type(field.type)
        flattened.append(flatten)
        fields.append(
            pa.field(target, pa.string(), nullable=field.nullable)
            if flatten else field.with_name(target)
        )
    output_schema = pa.schema(fields)

    # Prep owns the __lc companion of a text column. Reject collisions before
    # it can replace a column the user explicitly asked to retain.
    targets = {name.lower() for name in output_schema.names}
    for field in output_schema:
        if lance_tools.is_text_type(field.type):
            companion = field.name + lance_tools.LC_SUFFIX
            if companion.lower() in targets:
                raise FileError(
                    f"{companion!r} conflicts with the search companion for "
                    f"{field.name!r}; rename one of these columns"
                )

    def converted():
        for batch in batches([source for source, _ in selected]):
            arrays = [
                pa.array(
                    [lance_tools.flatten_value(value) for value in batch.column(source).to_pylist()],
                    type=pa.string(),
                ) if flatten else batch.column(source)
                for (source, _), flatten in zip(selected, flattened)
            ]
            yield pa.RecordBatch.from_arrays(arrays, schema=output_schema)

    return pa.RecordBatchReader.from_batches(output_schema, converted())


def cmd_prep(args) -> int:
    import lance

    path = Path(args.input).resolve()
    fmt = detect_format(path, args.format, ext_map=EXT_FORMAT_SHOW, formats=_FORMATS)
    if not (path.is_dir() if fmt == "lance" else path.is_file()):
        raise SystemExit(f"error: no such {'Lance dataset' if fmt == 'lance' else 'file'}: {path}")
    output = Path(args.output).absolute() if args.output else (
        path.with_name(f"{path.stem}.prepared.lance")
        if fmt == "lance" else path.with_suffix(".lance")
    )
    if output.suffix != ".lance":
        raise SystemExit("error: output path must end in .lance")
    if output.exists() or output.is_symlink():
        raise SystemExit(f"error: output already exists: {output}; choose another path with -o")
    if fmt == "lance" and path in output.resolve().parents:
        raise SystemExit("error: output cannot be inside the source Lance dataset")
    if lance_tools._is_managed_internal(output.resolve()):
        raise SystemExit("error: output cannot be inside a Quarry-managed internal directory")
    if args.batch_rows <= 0:
        raise SystemExit("error: --batch-rows must be greater than zero")

    try:
        with open_source(path, fmt, args.batch_rows) as (schema, row_count, batches):
            print(f"Rows: {row_count:,}")
            print("Available columns:")
            for field in schema:
                print(f"  {field.name} ({field.type})")
            if not schema.names:
                raise FileError("dataset has no columns")
            if args.columns is not None:
                selected = plan_columns(schema.names, args.columns)
            else:
                print("Enter columns in the desired order, separated by ';'.")
                print("Use original_name=new_name to rename; bare names stay unchanged.")
                while True:
                    try:
                        selected = plan_columns(schema.names, input("Columns to keep: "))
                        break
                    except FileError as exc:
                        print(f"error: {exc}", file=sys.stderr)
            names = [target for _, target in selected]
            prompt_column = lance_tools.resolve_prompt_column(names, args.prompt_column)
            reader = selected_reader(schema, batches, selected)
            print(f"Keeping: {'; '.join(f'{old}={new}' for old, new in selected)}")
            print(f"Prompt column: {prompt_column}")
            output.parent.mkdir(parents=True, exist_ok=True)
            # Only publish a fully prepared dataset. Failure or cancellation
            # removes the staging directory and leaves the source untouched.
            with tempfile.TemporaryDirectory(dir=output.parent, prefix=".quarry-prep-") as work:
                staged = Path(work) / "dataset.lance"
                ds = lance.write_dataset(reader, str(staged), mode="create")
                print(f"Converted {ds.count_rows()} row(s); preparing…", flush=True)
                lance_tools._build_one(
                    staged, None, [], [], False, auto_btree=True,
                    keep_history=False, emit=lambda line: print(line, flush=True),
                    flatten=False, prompt_column=prompt_column,
                )
                rows = lance.dataset(str(staged)).count_rows()
                # Reserve the destination so a concurrent creator is never
                # replaced, even if it appeared while conversion was running.
                output.mkdir()
                try:
                    staged.replace(output)
                except BaseException:
                    output.rmdir()
                    raise
            print(f"Prepared {output} ({rows} row(s))")
        return 0
    except (EOFError, KeyboardInterrupt):
        print("\nCancelled; no output dataset created.", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


def register(subparsers) -> None:
    p = subparsers.add_parser(
        "prep", help="select columns, convert to Lance, and prep in one command",
        description=(
            "Interactively select, rename, and order columns, then convert to Lance, "
            "flatten lists, remove empty/duplicate prompt rows, and build search indices. "
            "Supports Parquet, CSV/TSV, JSON/JSONL/NDJSON, and Lance. "
            "The source is preserved; an existing output is never overwritten."
        ),
        parents=[format_parent(_FORMATS)],
    )
    p.add_argument("input", help="a supported data file or .lance dataset")
    p.add_argument(
        "-o", "--output", help="output dataset (default: <stem>.lance beside the input, "
        "or <stem>.prepared.lance for Lance input)",
    )
    p.add_argument(
        "--columns", help="skip the prompt with an ordered semicolon-separated selection, "
        "e.g. 'caption=prompt;tags;score' (bare names keep their names)",
    )
    p.add_argument(
        "--prompt-column", help="prompt column after renaming (default: first of "
        "prompt/text/caption/description/value present, else the first selected column)",
    )
    p.add_argument("--batch-rows", type=int, default=50_000, help="rows per batch (default: 50000)")
    p.set_defaults(func=cmd_prep)
