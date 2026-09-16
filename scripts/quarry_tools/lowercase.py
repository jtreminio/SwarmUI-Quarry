"""Replace original Lance text columns with their prepared lowercase companions."""

from __future__ import annotations

import sys
from datetime import timedelta
from pathlib import Path

from .common import FileError

SUFFIX = "__lc"
SCALAR_TYPES = {"NGram": "NGRAM", "BTree": "BTREE", "Bitmap": "BITMAP", "LabelList": "LABEL_LIST"}


def find_datasets(directory: Path) -> list[Path]:
    """Select a dataset itself, or only datasets immediately inside a directory."""
    if not directory.is_dir():
        raise FileError(f"not a directory: {directory}")
    if (directory / "_versions").is_dir():
        return [directory]
    if directory.name.endswith(".lance"):
        raise FileError(f"not a Lance dataset: {directory}")
    datasets = sorted(
        child for child in directory.iterdir()
        if child.is_dir() and child.name.endswith(".lance")
        and (child / "_versions").is_dir()
    )
    if not datasets:
        raise FileError(f"no immediate child .lance datasets in {directory}")
    return datasets


def replace_companions(path: Path, emit=print) -> int:
    import lance
    import pyarrow as pa

    source = lance.dataset(str(path))
    schema = source.schema
    pairs = {
        name[:-len(SUFFIX)]: name for name in schema.names
        if name.endswith(SUFFIX) and name[:-len(SUFFIX)] in schema.names
    }
    if not pairs:
        emit("  no matching __lc columns; unchanged")
        return 0
    companions = set(pairs.values())
    if companions.intersection(pairs):
        raise FileError("overlapping companion pairs (such as x, x__lc, x__lc__lc)")
    for original, companion in pairs.items():
        for name in (original, companion):
            kind = schema.field(name).type
            if not (pa.types.is_string(kind) or pa.types.is_large_string(kind)):
                raise FileError(f"{name!r} is not a text column")

    # Validate the index plan before modifying the dataset. These are the scalar
    # types used by Quarry prep; don't silently discard an unfamiliar index.
    renamed = {companion: original for original, companion in pairs.items()}
    indexes = []
    for index in source.list_indices():
        kind = SCALAR_TYPES.get(index["type"])
        if kind is None or len(index["fields"]) != 1:
            raise FileError(f"unsupported index {index['name']!r}: {index['type']}")
        # list_indices quotes unusual names (e.g. `tag with spaces__lc`).
        field = source.lance_schema.field(index["fields"][0]).name()
        if field not in schema.names:
            raise FileError(f"unsupported nested index {index['name']!r}")
        indexes.append((index["name"], renamed.get(field, field), kind))

    # Preserve column order, nulls, row order, and Arrow metadata. Stream from the
    # pinned source version: overwrite commits new files without deleting those
    # being read. Cleanup only happens after all indexes are successfully built.
    fields = [field for field in schema if field.name not in companions]
    read_names = [pairs.get(field.name, field.name) for field in fields]
    output_schema = pa.schema(
        [schema.field(pairs[field.name]).with_name(field.name).with_metadata(field.metadata)
         if field.name in pairs else field for field in fields],
        metadata=schema.metadata,
    )

    def batches():
        for batch in source.scanner(columns=read_names, scan_in_order=True).to_batches():
            yield pa.RecordBatch.from_arrays(
                [batch.column(name) for name in read_names], schema=output_schema
            )

    emit(f"  replacing: {', '.join(f'{c} -> {o}' for o, c in pairs.items())}")
    try:
        reader = pa.RecordBatchReader.from_batches(output_schema, batches())
        result = lance.write_dataset(reader, str(path), mode="overwrite")
        for name, field, kind in indexes:
            emit(f"  rebuilding {kind} index on {field!r}")
            result.create_scalar_index(field, kind, name=name, replace=True)
    except BaseException:
        # Keep the original usable if writing or index construction fails.
        source.restore()
        raise
    stats = result.cleanup_old_versions(older_than=timedelta(0), delete_unverified=True)
    emit(f"  replaced {len(pairs)} column(s); pruned {stats.old_versions} old version(s)")
    return len(pairs)


def cmd_lowercase(args) -> int:
    try:
        targets = find_datasets(Path(args.input).expanduser().resolve())
    except FileError as exc:
        raise SystemExit(f"error: {exc}") from exc
    failed = 0
    for path in targets:
        print(f"\n=== {path} ===", flush=True)
        try:
            replace_companions(path, emit=lambda line: print(line, flush=True))
        except Exception as exc:
            failed += 1
            print(f"  FAIL {path}: {exc}", file=sys.stderr, flush=True)
    print(f"\nProcessed {len(targets) - failed}/{len(targets)} dataset(s); {failed} failed.")
    return 1 if failed else 0


def register(subparsers) -> None:
    parser = subparsers.add_parser(
        "lowercase",
        help="replace original columns with matching __lc companions in place",
        description=(
            "Replace each text column X with its existing X__lc values and remove "
            "X__lc. Rebuild scalar indexes and delete old versions and data files. "
            "Original capitalization is permanently discarded. Columns without a "
            "matching companion are unchanged."
        ),
    )
    parser.add_argument("input", help="a Lance dataset directory, or its parent (no recursion)")
    parser.set_defaults(func=cmd_lowercase)
