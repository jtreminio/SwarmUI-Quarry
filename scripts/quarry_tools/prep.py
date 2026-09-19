"""Interactive selection, conversion, and preparation of a single dataset."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

from . import lance as lance_tools
from .prep_clean import cleaned_reader
from . import storage
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
    if fmt in ("json", "jsonl"):
        from .json_schema import open_json_source

        with open_json_source(path, fmt, batch_rows) as source:
            yield source
        return

    if fmt == "lance":
        import lance

        ds = lance.dataset(str(path))
        logical = storage.logical_reader(ds, path, batch_rows=batch_rows)
        yield logical.schema, ds.count_rows(), lambda names: storage.logical_reader(
            ds, path, names=names, batch_rows=batch_rows
        )
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
    """Rename columns, flatten simple lists, and preserve shallow records."""
    import pyarrow as pa

    fields = []
    flattened = []
    for source, target in selected:
        field = schema.field(source)
        lance_tools.validate_record_type(field.type, source)
        flatten = lance_tools.is_list_type(field.type) and not lance_tools.is_record_type(field.type)
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

    if args.resume:
        return resume_prep(args)
    if not args.input:
        raise SystemExit("error: provide an input file or --resume CHECKPOINT")
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
                print("Press Enter to keep all available columns in their original order and with their original names.")
                while True:
                    try:
                        raw = input("Columns to keep: ")
                        selected = (plan_columns(schema.names, raw) if raw.strip()
                                    else [(name, name) for name in schema.names])
                        break
                    except FileError as exc:
                        print(f"error: {exc}", file=sys.stderr)
            names = [target for _, target in selected]
            prompt_column = lance_tools.resolve_prompt_column(names, args.prompt_column)
            from .json_schema import validate_empty_selections
            validate_empty_selections(schema, selected, prompt_column)
            reader = selected_reader(schema, batches, selected)
            print(f"Keeping: {'; '.join(f'{old}={new}' for old, new in selected)}")
            print(f"Prompt column: {prompt_column}")
            output.parent.mkdir(parents=True, exist_ok=True)
            # Retain completed conversion on index failure. Incomplete conversion
            # is still discarded, and only fully indexed data is published.
            work = Path(tempfile.mkdtemp(dir=output.parent, prefix=".quarry-prep-"))
            ready = published = False
            try:
                staged = work / "dataset.lance"
                emit = lambda line: print(line, flush=True)
                with tempfile.TemporaryDirectory(dir=work, prefix="clean-") as scratch:
                    with cleaned_reader(
                        reader, prompt_column, Path(scratch), batch_rows=args.batch_rows,
                        memory_limit=args.memory_limit, emit=emit,
                    ) as cleaned:
                        expected = storage.LogicalDigest(cleaned.schema)
                        encoded, pairs = storage.encoded_reader(cleaned, expected)
                        ds = lance.write_dataset(encoded, str(staged), mode="create", data_storage_version=storage.DATA_STORAGE_VERSION,
                                                 enable_stable_row_ids=False)
                        storage.write_descriptor(staged, pairs)
                        storage.verify_dataset(staged, expected, trusted_staging=True)
                (work / "prep.json").write_text(json.dumps({
                    "version": 3, "output": str(output), "prompt_column": prompt_column,
                    "storage_policy": 2, "search_policy": 1,
                    "logical_digest": expected.result(),
                    "logical_schema": [[field.name, str(field.type)] for field in expected.schema],
                }), encoding="utf-8")
                ready = True
                print(f"Wrote {ds.count_rows():,} cleaned row(s); building search indices…", flush=True)
                rows = index_and_publish(work, output, prompt_column, emit)
                published = True
            finally:
                if published or not ready:
                    shutil.rmtree(work)
                else:
                    report_checkpoint(work)
            print(f"Prepared {output} ({rows} row(s))")
        return 0
    except (EOFError, KeyboardInterrupt):
        print("\nCancelled; no output dataset created.", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


def report_checkpoint(work):
    print(f"Cleaned dataset retained in: {work}", file=sys.stderr)
    print(f"Resume indexing: ./quarry prep --resume {shlex.quote(str(work))}", file=sys.stderr)


def index_and_publish(work, output, prompt_column, emit, *, resume=False):
    import lance

    staged = work / "dataset.lance"
    checkpoint_file = work / "prep.json"
    checkpoint = json.loads(checkpoint_file.read_text()) if checkpoint_file.exists() else {}
    reader = storage.logical_reader(lance.dataset(str(staged)), staged, trusted_staging=True)
    actual = storage.LogicalDigest(reader.schema)
    for batch in reader:
        actual.update(batch)
    if checkpoint.get("version") == 3:
        if checkpoint.get("storage_policy") != 2 or checkpoint.get("search_policy") != 1:
            raise FileError("unsupported prep checkpoint storage policy")
        if list(actual.result()) != checkpoint.get("logical_digest"):
            raise FileError("prep checkpoint logical values changed; rebuild from original input")
        if [[field.name, str(field.type)] for field in actual.schema] != checkpoint.get("logical_schema"):
            raise FileError("prep checkpoint logical schema changed; rebuild from original input")
        storage.verify_helpers(staged)
    existing_layout = storage.read_layout(staged, trusted_staging=True)
    _, has_records = storage.helper_layout(actual.schema)
    if not (staged / storage.DESCRIPTOR).exists() or (has_records and existing_layout["version"] == 1):
        from .optimize import optimize_dataset
        optimize_dataset(staged, emit, auto_btree=True)
        return publish_dataset(staged, output)
    # Rust's tempfile crate reads TMPDIR directly. Changing Python's cached
    # tempfile.tempdir would not redirect Lance's spill files.
    with tempfile.TemporaryDirectory(dir=work, prefix="index-") as scratch:
        previous = os.environ.get("TMPDIR")
        os.environ["TMPDIR"] = scratch
        try:
            emit(f"Index spill directory: {scratch}")
            lance_tools._build_one(
                staged, None, [], [], False, auto_btree=True,
                keep_history=False, emit=emit, clean=False,
                flatten=False, prompt_column=prompt_column,
                reuse_companions=resume,
                trusted_staging=True,
            )
        finally:
            if previous is None:
                os.environ.pop("TMPDIR", None)
            else:
                os.environ["TMPDIR"] = previous
    from .optimize import completion_marker
    ds = lance.dataset(str(staged))
    storage.verify_helpers(staged)
    storage.verify_dataset(staged, actual, trusted_staging=True)
    storage.write_descriptor(staged, storage.read_descriptor(staged, ds.schema, trusted_staging=True),
                             optimized=completion_marker(ds), finalize=True)
    return publish_dataset(staged, output)


def publish_dataset(staged, output):
    import lance

    rows = lance.dataset(str(staged)).count_rows()
    # Reserve the destination so a concurrent creator is never replaced.
    output.mkdir()
    try:
        staged.replace(output)
    except BaseException:
        output.rmdir()
        raise
    return rows


def resume_prep(args):
    work = Path(args.resume).expanduser().resolve()
    try:
        if args.input or args.columns or args.prompt_column or args.format:
            raise FileError("--resume uses the saved selection; do not supply input/column/format options")
        if not work.name.startswith(".quarry-prep-") or work.is_symlink():
            raise FileError("not a Quarry prep checkpoint directory")
        checkpoint = json.loads((work / "prep.json").read_text(encoding="utf-8"))
        staged = work / "dataset.lance"
        if checkpoint.get("version") not in (1, 2, 3) or staged.is_symlink() or not (staged / "_versions").is_dir():
            raise FileError("not a completed Quarry conversion checkpoint")
        if checkpoint.get("version") in (2, 3) and not (staged / storage.DESCRIPTOR).is_file():
            raise FileError("casing storage descriptor is missing from the checkpoint")
        output = Path(args.output).expanduser().absolute() if args.output else Path(checkpoint["output"])
        if output.suffix != ".lance" or output.exists() or output.is_symlink():
            raise FileError("output must be a new .lance path; choose another path with -o")
        if work == output.resolve() or work in output.resolve().parents or lance_tools._is_managed_internal(output.resolve()):
            raise FileError("output cannot be inside the checkpoint or a Quarry-managed internal directory")
        output.parent.mkdir(parents=True, exist_ok=True)
        rows = index_and_publish(
            work, output, checkpoint["prompt_column"],
            lambda line: print(line, flush=True), resume=True,
        )
        shutil.rmtree(work)
        print(f"Prepared {output} ({rows} row(s))")
        return 0
    except (Exception, KeyboardInterrupt) as exc:
        print(f"error: {exc or 'Cancelled'}", file=sys.stderr)
        if (work / "prep.json").is_file():
            report_checkpoint(work)
        return 1


def register(subparsers) -> None:
    p = subparsers.add_parser(
        "prep", help="select columns, convert to Lance, and prep in one command",
        description=(
            "Interactively select, rename, and order columns, then convert to Lance, "
            "flatten simple lists, preserve object records, remove empty/duplicate complete prompts, and build search indices. "
            "Supports Parquet, CSV/TSV, JSON/JSONL/NDJSON, and Lance. "
            "The source is preserved; an existing output is never overwritten."
        ),
        parents=[format_parent(_FORMATS)],
    )
    p.add_argument("input", nargs="?", help="a supported data file or .lance dataset")
    p.add_argument("--resume", metavar="CHECKPOINT", help="resume indexing a retained prep checkpoint")
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
    p.add_argument(
        "--memory-limit", default="32GB",
        help="DuckDB cleanup memory budget (default: 32GB); larger operations spill "
        "to temporary disk space beside the output",
    )
    p.set_defaults(func=cmd_prep)
