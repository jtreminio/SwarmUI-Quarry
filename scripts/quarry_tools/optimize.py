"""Rewrite standalone datasets into Quarry's lossless casing/miniblock format."""
from __future__ import annotations

import os
import json
import re
import shutil
import sys
import tempfile
from contextlib import ExitStack
from datetime import timedelta
from pathlib import Path

from .common import FileError
from .lowercase import find_datasets, SCALAR_TYPES
from . import storage

OPTIMIZATION_VERSION = 1
_SKIPPED = object()


def completion_marker(ds):
    return {"version": OPTIMIZATION_VERSION, "lance_version": ds.version}


def _already_optimized(ds, path, *, dry_run):
    descriptor = path / storage.DESCRIPTOR
    if not descriptor.exists():
        return False
    pairs = storage.read_descriptor(path, ds.schema)
    marker = json.loads(descriptor.read_text(encoding="utf-8")).get("optimized")
    if marker is not None and marker != completion_marker(ds):
        return False
    text = {f.name for f in ds.schema if storage.is_text(f.type)}
    if set(pairs) != text or storage.legacy_pairs(ds.schema) or len(ds.versions()) != 1:
        return False
    fragments = {f.fragment_id for f in ds.get_fragments()}
    indexed = {i["fields"][0] for i in ds.list_indices()
               if i["type"] == "NGram" and len(i["fields"]) == 1
               and fragments <= set(i["fragment_ids"] or [])}
    if not text <= indexed:
        return False
    # Older completed datasets have the codec descriptor but no completion marker.
    if marker is None and not dry_run:
        storage.write_descriptor(path, pairs, optimized=completion_marker(ds))
    return True


def _native_panic(exc):
    return type(exc).__module__ == "pyo3_runtime" and type(exc).__name__ == "PanicException"


def _retryable_write_error(exc):
    message = str(exc)
    panic = _native_panic(exc)
    if re.search(r"Mini-block chunk size \d+ bytes exceeds the 32768 byte metadata limit", message):
        return isinstance(exc, Exception) or panic
    # Lance 7 can surface an encoder worker panic instead of the size error.
    return panic and ("RecvError(())" in message or "assertion failed: chunk_bytes <= max_chunk_size" in message)


def index_plan(ds):
    """Fail before writing if an existing index cannot be faithfully recreated."""
    legacy = storage.legacy_pairs(ds.schema)
    renamed = {v: k for k, v in legacy.items()}
    plan = []
    for index in ds.list_indices():
        kind = SCALAR_TYPES.get(index["type"])
        if kind is None or len(index["fields"]) != 1:
            raise FileError(f"unsupported index {index['name']!r}: {index['type']}")
        field = ds.lance_schema.field(index["fields"][0]).name()
        if field not in ds.schema.names:
            raise FileError(f"unsupported nested index {index['name']!r}")
        if storage.is_text(ds.schema.field(field).type) and kind != "NGRAM":
            raise FileError(f"cannot preserve case-sensitive {kind} index on {field!r}")
        plan.append((index["name"], renamed.get(field, field), kind))
    return plan


def optimize_dataset(path, emit=print, dry_run=False, *, auto_btree=False, get_spill_directory=None):
    import lance
    from . import lance as lance_tools

    path = Path(path)
    if path.is_symlink() or lance_tools._is_managed_internal(path.resolve()):
        raise FileError(f"not a standalone dataset: {path}")
    source = lance.dataset(str(path))
    if _already_optimized(source, path, dry_run=dry_run):
        emit(f"  skipped: already optimized (Lance version {source.version})")
        return _SKIPPED
    plan = index_plan(source)
    reader = storage.logical_reader(source, path)
    expected = storage.LogicalDigest(reader.schema)
    encoded, pairs = storage.encoded_reader(reader, expected)
    reserved = {name for name, _, kind in plan if kind != "NGRAM"}
    ngram_names = {}
    for field in pairs:
        name = field + "_idx"
        while name in reserved:
            name += "_ngram"
        reserved.add(name)
        ngram_names[field] = name
    extra_btree = [n for n in lance_tools._numeric_columns(source)
                   if not any(f == n for _, f, _ in plan)] if auto_btree else []
    before = lance_tools._dir_size(path)
    emit(f"  {source.count_rows():,} rows; casing/miniblock: {', '.join(pairs) or '(no text columns)'}")
    if dry_run:
        encoded.close()
        return
    work = Path(tempfile.mkdtemp(dir=path.parent, prefix=".quarry-optimize-"))
    staged = work / "dataset.lance"
    backup = work / "original.lance"
    previous = os.environ.get("TMPDIR")
    try:
        os.environ["TMPDIR"] = str(get_spill_directory() if get_spill_directory else work)
        attempts = ((65536, True), (1024, True), (1024, False))
        for attempt, (batch_rows, miniblock) in enumerate(attempts):
            if attempt:
                layout = "1,024-row write batches (miniblock)" if miniblock else "Lance's default layout"
                emit(f"  retrying dataset with {layout}…")
                reader = storage.logical_reader(source, path, batch_rows=batch_rows)
                expected = storage.LogicalDigest(reader.schema)
                encoded, pairs = storage.encoded_reader(reader, expected, miniblock=miniblock)
            try:
                lance.write_dataset(encoded, str(staged), mode="create", data_storage_version=storage.DATA_STORAGE_VERSION)
                break
            except BaseException as exc:
                if not _retryable_write_error(exc):
                    if _native_panic(exc):
                        raise FileError(f"Lance writer panicked: {exc}") from exc
                    raise
                if attempt == len(attempts) - 1:
                    raise FileError(f"Lance write failed after layout retries: {exc}") from exc
                emit(f"  Lance write failed: {exc}")
            finally:
                encoded.close()
            if staged.exists():
                shutil.rmtree(staged)
        storage.write_descriptor(staged, pairs)
        # Build each index once; prune only after every index is complete.
        lance_tools._build_one(staged, None, [], extra_btree, False, False, True,
                               emit, clean=False, flatten=False, ngram_names=ngram_names)
        ds = lance.dataset(str(staged))
        for name, field, kind in plan:
            if kind != "NGRAM":
                ds.create_scalar_index(field, kind, name=name, replace=True)
        ds = lance.dataset(str(staged))
        actual_indexes = {(ds.lance_schema.field(i["fields"][0]).name(), SCALAR_TYPES.get(i["type"]))
                          for i in ds.list_indices() if len(i["fields"]) == 1}
        required = {(n, "NGRAM") for n in pairs} | {(f, k) for _, f, k in plan}
        if not required <= actual_indexes:
            raise FileError(f"rewrite failed to retain required indexes: {required - actual_indexes}")
        ds.cleanup_old_versions(older_than=timedelta(0), delete_unverified=True)
        emit("  verifying reconstructed original values…")
        storage.verify_dataset(staged, expected)
        if len(lance.dataset(str(staged)).versions()) != 1:
            raise FileError("rewrite retained unexpected historical versions")
        if lance.dataset(str(path)).version != source.version:
            raise FileError("source changed during migration; refusing replacement")
        storage.write_descriptor(staged, pairs, optimized=completion_marker(ds))
        path.rename(backup)
        try:
            staged.rename(path)
        except BaseException:
            backup.rename(path)
            raise
        after = lance_tools._dir_size(path)
        emit(f"  size: {lance_tools._human(before)} -> {lance_tools._human(after)}")
    finally:
        if previous is None:
            os.environ.pop("TMPDIR", None)
        else:
            os.environ["TMPDIR"] = previous
        # If rollback itself failed, keep the only original and report its location.
        if backup.exists() and not path.exists():
            emit(f"  recovery required: original dataset retained at {backup}")
        else:
            shutil.rmtree(work)
    return before, after


def cmd_optimize(args):
    from .lance import _human

    try:
        root = Path(args.input).expanduser().absolute()
        if root.is_symlink():
            raise FileError("symlink dataset paths are not supported")
        targets = find_datasets(root)
    except FileError as exc:
        raise SystemExit(f"error: {exc}") from exc
    failures = []
    skipped = processed = 0
    total_before = total_after = 0
    # Lance caches its spill directory across datasets, so keep it until the batch ends.
    with ExitStack() as cleanup:
        spill = None

        def get_spill_directory():
            nonlocal spill
            if spill is None:
                parent = root.parent if root in targets else root
                spill = cleanup.enter_context(tempfile.TemporaryDirectory(
                    dir=parent, prefix=".quarry-optimize-spill-",
                ))
            return spill

        for path in targets:
            print(f"\n=== {path} ===", flush=True)
            try:
                sizes = optimize_dataset(path, lambda line: print(line, flush=True), args.dry_run,
                                         get_spill_directory=get_spill_directory)
                if sizes is _SKIPPED:
                    skipped += 1
                    continue
                processed += 1
                if sizes is not None:
                    before, after = sizes
                    total_before += before
                    total_after += after
            except Exception as exc:
                reason = " ".join(str(exc).split()) or type(exc).__name__
                failures.append((path, reason))
                print(f"  FAIL {path}: {reason}", file=sys.stderr, flush=True)
    print(f"\n{'Inspected' if args.dry_run else 'Optimized'} {processed}/{len(targets)} dataset(s); "
          f"{skipped} skipped; {len(failures)} failed.")
    if failures:
        print("Failed datasets:")
        for path, reason in failures:
            print(f"  {path}: {reason}")
    if args.dry_run:
        print("Dry run: no datasets changed; size savings not measured.")
    elif processed == 0:
        print("No datasets optimized; size savings not measured.")
    else:
        saved = total_before - total_after
        percentage = f"{abs(saved) / total_before:.1%}" if total_before else "n/a"
        print("\nSize summary (successfully optimized datasets only):")
        print(f"  Before:   {_human(total_before)}")
        print(f"  After:    {_human(total_after)}")
        print(f"  {'Saved:' if saved >= 0 else 'Increase:':9} {_human(abs(saved))} ({percentage})")
    return int(bool(failures))


def register(subparsers):
    parser = subparsers.add_parser("optimize", help="losslessly rewrite casing and text layout; discard old versions",
        description="Rewrite a dataset or immediate child datasets using lossless casing patches and miniblock text layout. Retain every supported index and only the current version. Stop dataset readers/writers before running. Temporary space for a full rewritten dataset is required.")
    parser.add_argument("input", help="a Lance dataset or its parent directory (no recursion)")
    parser.add_argument("--dry-run", action="store_true", help="inspect conversion and index compatibility without writing")
    parser.set_defaults(func=cmd_optimize)
