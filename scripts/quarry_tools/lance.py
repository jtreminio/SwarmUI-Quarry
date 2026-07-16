"""`quarry lance` subcommands: create and prep standalone Lance datasets.

convert / prep -- convert (carried over from to_lancedb.py; ``quarry convert
to-lance`` remains as an alias) turns CSV/JSONL/Parquet files into .lance
datasets. prep is the merger of the old clean and index subcommands: it cleans
each dataset (flatten list columns, drop empty/duplicate rows) and then builds
the Quarry search indices, all in one pass via ``process_dataset``. Heavy
libraries (lance, pyarrow, duckdb) are imported lazily inside the command
functions.
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import timedelta
from pathlib import Path

from .common import (
    EXT_FORMAT,
    as_pool_results,
    detect_format,
    format_parent,
    quote_ident,
    quote_ident_backtick,
    quote_literal,
    workers_parent,
)

# Conventionally named text columns, in preference order. Mirrors the extension's
# PromptColumnResolver (and to_lancedb) so the column we clean is the one it reads.
_PREFERRED_PROMPT_COLUMNS = ("prompt", "text", "caption", "description", "value")


class DatasetError(Exception):
    """A per-dataset problem that should be reported without aborting the batch."""


# ===========================================================================
# clean -- shared per-dataset logic used by prep's clean pass
# ===========================================================================


def resolve_prompt_column(columns: list[str], override: str | None) -> str | None:
    """Pick the prompt column the way the extension's PromptColumnResolver does."""
    if override:
        for col in columns:
            if col.lower() == override.lower():
                return col
        raise DatasetError(
            f"--prompt-column {override!r} not found; "
            f"columns: {', '.join(columns) or '(none)'}"
        )
    by_lower = {col.lower(): col for col in columns}
    for preferred in _PREFERRED_PROMPT_COLUMNS:
        if preferred in by_lower:
            return by_lower[preferred]
    return columns[0] if columns else None


def is_text_type(dtype) -> bool:
    """True for the Arrow string variants we can trim (utf8 / large_utf8 / view)."""
    import pyarrow as pa

    return (
        pa.types.is_string(dtype)
        or pa.types.is_large_string(dtype)
        or pa.types.is_string_view(dtype)
    )


# How list elements are joined when a list column is flattened to a string.
_LIST_SEPARATOR = ", "


def is_list_type(dtype) -> bool:
    """True for any Arrow list variant we flatten to a string."""
    import pyarrow as pa

    checks = (
        "is_list", "is_large_list", "is_fixed_size_list",
        "is_list_view", "is_large_list_view",
    )
    return any(
        getattr(pa.types, name)(dtype) for name in checks if hasattr(pa.types, name)
    )


def flatten_value(value):
    """Join one list cell to a string the way Lance's array_to_string does."""
    if value is None:
        return None
    parts: list[str] = []

    def walk(items) -> None:
        for el in items:
            if el is None:
                continue
            if isinstance(el, list):
                walk(el)
            else:
                parts.append(str(el))

    walk(value)
    return _LIST_SEPARATOR.join(parts)


def flatten_list_columns(ds, path: Path, columns: list[str]):
    """Rewrite each list column of ``ds`` to a ', '-joined string; return a reopened
    handle."""
    import lance

    tmp = "__quarry_flat_tmp__"
    for col in columns:
        ds.add_columns(
            {tmp: f"array_to_string({quote_ident_backtick(col)}, '{_LIST_SEPARATOR}')"},
            read_columns=[col],
        )
        ds.drop_columns([col])
        ds.alter_columns({"path": tmp, "name": col})
    return lance.dataset(str(path))


def normalize_prompt(value: str) -> str:
    """Collapse a prompt to its dedup key: lowercased, non-alphanumerics dropped."""
    return "".join(ch for ch in value.lower() if ch.isalnum())


def find_duplicate_rowids(ds, col: str, as_list: bool = False) -> list[int]:
    """Return the ``_rowid``s of duplicate rows of ``col`` (every row past the first
    in its normalized group)."""
    seen: set[str] = set()
    dup_rowids: list[int] = []
    for batch in ds.scanner(columns=[col], with_row_id=True).to_batches():
        values = batch.column(col).to_pylist()
        rowids = batch.column("_rowid").to_pylist()
        for value, rowid in zip(values, rowids):
            if as_list:
                value = flatten_value(value)
            if value is None:
                continue
            key = normalize_prompt(value)
            if not key:
                continue  # empty/whitespace/all-punctuation: left to the empty pass
            if key in seen:
                dup_rowids.append(rowid)
            else:
                seen.add(key)
    return dup_rowids


def count_flattened_empty_rows(ds, col: str) -> int:
    """Count rows whose list column ``col`` would be empty once flattened."""
    empty = 0
    for batch in ds.scanner(columns=[col]).to_batches():
        for value in batch.column(col).to_pylist():
            flat = flatten_value(value)
            if flat is None or not flat.strip():
                empty += 1
    return empty


def empty_row_predicate(col: str, dtype) -> str:
    """Lance filter matching empty rows of ``col``: NULL always, plus space-only for
    a text column."""
    ident = quote_ident_backtick(col)
    if is_text_type(dtype):
        return f"{ident} IS NULL OR length(trim({ident})) = 0"
    return f"{ident} IS NULL"


# A single ``_rowid IN (...)`` delete predicate per this many rowids.
_DELETE_BATCH = 4096


def process_dataset(
    path: Path, override, dry_run, compact, dedup, flatten
) -> dict:
    """Flatten list columns and delete (or, with ``dry_run``, just count) the empty
    and normalized-duplicate rows of one dataset. Opens its own ``lance.dataset``."""
    import lance

    try:
        ds = lance.dataset(str(path))
    except Exception as exc:  # corrupt / incomplete / not a Lance dataset
        raise DatasetError(f"could not open dataset: {exc}") from exc

    columns = list(ds.schema.names)
    if not columns:
        raise DatasetError("dataset has no columns")
    list_cols = [
        name for name in columns if is_list_type(ds.schema.field(name).type)
    ]

    result = {
        "column": resolve_prompt_column(columns, override),
        "total": ds.count_rows(),
        "list_columns": len(list_cols) if flatten else 0,
        "flattened": 0,
        "empty": 0,
        "empty_removed": 0,
        "duplicate": 0,
        "duplicate_removed": 0,
    }

    if flatten and list_cols and not dry_run:
        ds = flatten_list_columns(ds, path, list_cols)
        result["flattened"] = len(list_cols)
        columns = list(ds.schema.names)

    col = resolve_prompt_column(columns, override)
    result["column"] = col
    dtype = ds.schema.field(col).type
    preview_list = dry_run and flatten and is_list_type(dtype)

    pred = empty_row_predicate(col, dtype)
    total = result["total"]
    if preview_list:
        empty = count_flattened_empty_rows(ds, col)
    else:
        empty = ds.scanner(columns=[col], filter=pred).count_rows()
    result["empty"] = empty

    if empty and not dry_run:
        ds.delete(pred)
        result["empty_removed"] = total - ds.count_rows()

    if dedup and (is_text_type(dtype) or preview_list):
        dup_rowids = find_duplicate_rowids(ds, col, as_list=preview_list)
        result["duplicate"] = len(dup_rowids)
        if dup_rowids and not dry_run:
            for start in range(0, len(dup_rowids), _DELETE_BATCH):
                chunk = dup_rowids[start : start + _DELETE_BATCH]
                ds.delete("_rowid IN (" + ",".join(str(r) for r in chunk) + ")")
            result["duplicate_removed"] = len(dup_rowids)

    if (
        compact
        and not dry_run
        and (
            result["flattened"]
            or result["empty_removed"]
            or result["duplicate_removed"]
        )
    ):
        ds.optimize.compact_files()
        ds.cleanup_old_versions(older_than=timedelta(0))
    return result


# ===========================================================================
# lance convert (aliased as `quarry convert to-lance`)
# ===========================================================================

_CONVERT_DESC_TEMPLATE = """\
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
    {cmd} <file-or-dir> [-o OUT] [--mode MODE] [-w N]
    {cmd} data.parquet
    {cmd} prompts.jsonl -o ./prompts.lance
    {cmd} ./shards/                 # one .lance per file
    {cmd} ./shards/ -o ./lance/     # into ./lance/
    {cmd} more.parquet -o ./prompts.lance --mode append

Modes: create (default, fails if the dataset exists), overwrite, append.
"""

_CONVERT_FORMATS = ("parquet", "csv", "jsonl")


def _convert_reader(fmt: str, *, parallel: bool = True) -> str:
    """DuckDB reader call with a ``?`` placeholder; ``parallel`` affects only CSV."""
    if fmt == "parquet":
        return "read_parquet(?)"
    if fmt == "csv":
        return "read_csv_auto(?)" if parallel else "read_csv_auto(?, parallel=false)"
    return "read_json(?, format='newline_delimited')"


def _convert_prompt_column(columns: list[str], override: str | None) -> str | None:
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
        reader_call = _convert_reader(fmt, parallel=parallel)
        columns = [
            row[0]
            for row in con.execute(
                f"DESCRIBE SELECT * FROM {reader_call}", [str(src)]
            ).fetchall()
        ]
        col = _convert_prompt_column(columns, prompt_column)
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


def cmd_convert(args) -> int:
    path = Path(args.input)
    if not path.exists():
        raise SystemExit(f"error: no such file or directory: {path}")

    jobs = _plan_jobs(path, args.output, args.format)
    single = len(jobs) == 1
    planned = [
        (
            src,
            detect_format(
                src, args.format, ext_map=EXT_FORMAT, formats=_CONVERT_FORMATS,
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


def register_convert(subparsers, name: str, invocation: str, alias_of=None) -> None:
    """Register the convert command as ``name``; ``invocation`` is the full
    command shown in the usage examples. ``alias_of`` marks it as an alias."""
    desc = _CONVERT_DESC_TEMPLATE.format(cmd=invocation)
    help_text = "convert csv/jsonl/parquet file(s) into .lance dataset(s)"
    if alias_of:
        desc = f"Alias of `{alias_of}`.\n\n" + desc
        help_text += f" (alias of `{alias_of}`)"

    p = subparsers.add_parser(
        name, help=help_text, description=desc,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        parents=[
            format_parent(
                _CONVERT_FORMATS,
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
    p.set_defaults(func=cmd_convert)


# ===========================================================================
# lance prep (the old clean + index subcommands, merged)
# ===========================================================================

_PREP_DESC = """\
Prep standalone Lance dataset(s) for Quarry: clean, then build search indices.

Each dataset is first cleaned -- list columns are flattened to ', '-joined
strings, and empty plus normalized-duplicate prompt rows are deleted (see the
--no-flatten / --no-dedup / --no-compact toggles and --prompt-column). This is
DESTRUCTIVE. Pass --no-clean to skip it, or --dry-run to preview what cleaning
would remove without touching anything.

An empty row is one whose prompt column is NULL or, for a text column, blank once
stripped of surrounding spaces. Deleting them keeps a random pick a plain
LIMIT/OFFSET (a native O(1) Lance seek) instead of a non-empty WHERE filter. A
duplicate row is one whose prompt, once normalized (lowercased, non-alphanumerics
dropped), was already seen earlier in the same dataset; the first row of each
group is kept. The prompt column is resolved per dataset the way the extension's
PromptColumnResolver does.

Then, for each chosen text column X, this builds a Lance NGRAM scalar index so Quarry's
substring filters (contains) are pushed down by the DuckDB lance extension. Quarry
matches case-insensitively by lowercasing the search value, so:

  * if X is already fully lowercase, the NGRAM index is built in place on X;
  * otherwise a lowercased companion X__lc (= lower(X)) is added and indexed.

The original column X is never modified. Pass --always-companion to force the X__lc
form even for lowercase columns.

Auto-builds a BTREE scalar index on every declared-numeric column so numeric range
filters (+= / -=) push down. --no-btree disables this; --btree a,b adds extras.
--bitmap is also accepted for exact-equality queries.

Lance is versioned: by default this prunes everything but the current version
afterward; pass --keep-history to retain old versions.

When given a directory, datasets are prepped in parallel (-j / --jobs, default 4).

Usage:
    quarry lance prep <dataset.lance | dir-searched-recursively> [options]
    quarry lance prep ~/data/AIConfigs/Quarry
    quarry lance prep ~/data/AIConfigs/Quarry -j 8
    quarry lance prep ./nl/ --text-columns prompt,caption
    quarry lance prep ./mixed/ --always-companion
    quarry lance prep ~/data/AIConfigs/Quarry --dry-run
    quarry lance prep ~/data/AIConfigs/Quarry --no-clean
"""

LC_SUFFIX = "__lc"

# Quarry-managed internal dirs we must never index or prune.
MANAGED_INTERNAL_DIRS = {".image-history", ".cache"}

_tlocal = threading.local()
_print_lock = threading.Lock()


def _duck():
    import duckdb

    con = getattr(_tlocal, "con", None)
    if con is None:
        con = duckdb.connect()
        con.execute("INSTALL lance; LOAD lance;")
        _tlocal.con = con
    return con


def _is_text(field) -> bool:
    import pyarrow as pa

    return pa.types.is_string(field.type) or pa.types.is_large_string(field.type)


def _is_numeric(field) -> bool:
    import pyarrow as pa

    t = field.type
    return (
        pa.types.is_integer(t) or pa.types.is_floating(t) or pa.types.is_decimal(t)
    )


def _numeric_columns(ds) -> list[str]:
    return [f.name for f in ds.schema if _is_numeric(f)]


def _is_managed_internal(path: Path) -> bool:
    return any(part in MANAGED_INTERNAL_DIRS for part in path.parts)


def _dir_size(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def _human(n: int) -> str:
    f = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if f < 1024 or unit == "TB":
            return f"{f:.1f} {unit}"
        f /= 1024


def _all_lowercase(path: str, col: str) -> bool:
    q = quote_ident(col)
    n = _duck().execute(
        f"SELECT count(*) FROM {quote_literal(path)} "
        f"WHERE {q} IS NOT NULL AND {q} != lower({q})"
    ).fetchone()[0]
    return n == 0


def _find_datasets(root: Path) -> list[Path]:
    """All Lance datasets at or under ``root``: directories ending in ``.lance`` that
    hold a ``_versions/`` manifest. Hidden dirs are skipped."""
    if root.name.startswith("."):
        return []
    found: list[Path] = []
    for dirpath, dirnames, _files in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        p = Path(dirpath)
        if p.name.endswith(".lance") and (p / "_versions").is_dir():
            found.append(p)
            dirnames[:] = []
    return sorted(found)


def _resolve_text_columns(ds, requested):
    names = set(ds.schema.names)
    if requested:
        missing = [c for c in requested if c not in names]
        if missing:
            raise SystemExit(
                f"error: --text-columns not found: {', '.join(missing)} "
                f"(have: {', '.join(sorted(names))})"
            )
        return requested
    return [f.name for f in ds.schema if _is_text(f) and not f.name.endswith(LC_SUFFIX)]


def _clean_one(path, prompt_column, dry_run, flatten, dedup, compact, emit) -> None:
    try:
        r = process_dataset(path, prompt_column, dry_run, compact, dedup, flatten)
    except DatasetError as exc:
        emit(f"  !! clean skipped: {exc}")
        return
    flat = r["list_columns"] if dry_run else r["flattened"]
    empties = r["empty"] if dry_run else r["empty_removed"]
    dups = r["duplicate"] if dry_run else r["duplicate_removed"]
    verb = "would clean" if dry_run else "cleaned"
    emit(
        f"  {verb} [{r['column']}]: flatten {flat} list col(s), "
        f"remove {empties} empty + {dups} duplicate of {r['total']} row(s)"
    )


def _build_one(
    path, text_columns, bitmap, btree, always_companion, auto_btree, keep_history,
    emit, clean=True, flatten=True, dedup=True, compact=True, prompt_column=None,
    dry_run=False,
) -> None:
    import lance

    emit(f"\n=== {path} ===")
    if clean:
        _clean_one(path, prompt_column, dry_run, flatten, dedup, compact, emit)
    if dry_run:
        return  # preview only -- nothing was cleaned, so there's nothing to index
    ds = lance.dataset(str(path))
    before = _dir_size(path)
    for col in _resolve_text_columns(ds, text_columns):
        if not always_companion and _all_lowercase(str(path), col):
            t = time.time()
            ds.create_scalar_index(col, "NGRAM", replace=True)
            emit(f"  {col!r}: already lowercase -> NGRAM in place in {time.time() - t:.1f}s")
            continue
        companion = col + LC_SUFFIX
        t = time.time()
        if companion in ds.schema.names:
            ds.drop_columns([companion])
            ds = lance.dataset(str(path))  # reopen without the stale column
            verb = "refreshed"
        else:
            verb = "added"
        ds.add_columns({companion: f"lower({quote_ident_backtick(col)})"})
        ds = lance.dataset(str(path))  # reopen to see the new column
        emit(f"  {col!r}: {verb} companion {companion!r} in {time.time() - t:.1f}s")
        t = time.time()
        ds.create_scalar_index(companion, "NGRAM", replace=True)
        emit(f"  {col!r}: NGRAM index on {companion!r} built in {time.time() - t:.1f}s")
    btree_cols = list(
        dict.fromkeys((_numeric_columns(ds) if auto_btree else []) + btree)
    )
    for col, kind in [(c, "BITMAP") for c in bitmap] + [
        (c, "BTREE") for c in btree_cols
    ]:
        if col not in ds.schema.names:
            emit(f"  !! {kind} column {col!r} not in schema; skipping")
            continue
        t = time.time()
        ds.create_scalar_index(col, kind, replace=True)
        emit(f"  {col!r}: {kind} index built in {time.time() - t:.1f}s")
    if not keep_history:
        stats = lance.dataset(str(path)).cleanup_old_versions(
            older_than=timedelta(0), delete_unverified=True
        )
        emit(f"  pruned {stats.old_versions} old version(s), reclaimed {_human(stats.bytes_removed)}")
    ds = lance.dataset(str(path))
    after = _dir_size(path)
    emit(f"  indices: {[(i['name'], i['type']) for i in ds.list_indices()]}")
    emit(f"  size: {_human(before)} -> {_human(after)}  (+{_human(after - before)})")


def cmd_prep(args) -> int:
    def split(s: str) -> list[str]:
        return [x.strip() for x in s.split(",") if x.strip()]

    text_columns = split(args.text_columns) if args.text_columns else None
    bitmap, btree = split(args.bitmap), split(args.btree)

    root = Path(args.input)
    if not root.exists():
        raise SystemExit(f"error: no such path: {root}")
    if root.name.endswith(".lance"):
        targets = [root]
    else:
        targets = _find_datasets(root)
        if not targets:
            raise SystemExit(f"error: no .lance datasets found under {root}")
    for blocked in [t for t in targets if _is_managed_internal(t)]:
        print(
            f"  !! refusing {blocked}: inside a Quarry-managed internal dir "
            f"({', '.join(sorted(MANAGED_INTERNAL_DIRS))}); skipping",
            file=sys.stderr,
        )
    targets = [t for t in targets if not _is_managed_internal(t)]
    if not targets:
        raise SystemExit(
            f"error: no eligible .lance datasets under {root} "
            f"(all were Quarry-managed internals)"
        )

    def run_one(path, emit) -> None:
        _build_one(
            path, text_columns, bitmap, btree, args.always_companion,
            auto_btree=not args.no_btree, keep_history=args.keep_history, emit=emit,
            clean=args.clean, flatten=args.flatten, dedup=args.dedup,
            compact=args.compact, prompt_column=args.prompt_column,
            dry_run=args.dry_run,
        )

    failed = 0
    jobs = max(1, min(args.jobs, len(targets)))
    if jobs == 1:
        for path in targets:
            try:
                run_one(path, lambda line: print(line, flush=True))
            except Exception as exc:  # keep going through a directory
                failed += 1
                print(f"  FAIL {path}: {exc}", file=sys.stderr)
    else:
        _duck()  # install the lance extension once up front

        def work(path):
            lines: list[str] = []
            try:
                run_one(path, lines.append)
                return path, lines, None
            except Exception as exc:  # keep going through a directory
                return path, lines, exc

        with ThreadPoolExecutor(max_workers=jobs) as pool:
            for future in as_completed([pool.submit(work, path) for path in targets]):
                path, lines, exc = future.result()
                with _print_lock:
                    for line in lines:
                        print(line, flush=True)
                    if exc is not None:
                        print(f"  FAIL {path}: {exc}", file=sys.stderr, flush=True)
                if exc is not None:
                    failed += 1

    if len(targets) > 1:
        verb = "Previewed" if args.dry_run else "Prepped"
        print(
            f"\n{verb} {len(targets) - failed}/{len(targets)} dataset(s) "
            f"with {jobs} job(s); {failed} failed."
        )
    return 1 if failed else 0


# ===========================================================================
# registration
# ===========================================================================


def register(subparsers) -> None:
    raw = argparse.RawDescriptionHelpFormatter

    register_convert(subparsers, "convert", "quarry lance convert")

    p = subparsers.add_parser(
        "prep",
        help="prep Lance dataset(s): clean, then build Quarry NGRAM/scalar indices",
        description=_PREP_DESC, formatter_class=raw,
    )
    p.add_argument(
        "input",
        help="a .lance dataset, or a directory searched recursively for them "
        "(hidden dirs like .cache / .image-history are skipped)",
    )
    p.add_argument(
        "--text-columns", default=None,
        help="comma-separated text columns to index (default: all string columns)",
    )
    p.add_argument(
        "--bitmap", default="",
        help="comma-separated low-cardinality columns for BITMAP indices",
    )
    p.add_argument(
        "--btree", default="",
        help="extra columns to BTREE, beyond the auto-detected numeric ones",
    )
    p.add_argument(
        "--no-btree", action="store_true",
        help="don't auto-build BTREE indices on declared-numeric columns",
    )
    p.add_argument(
        "--always-companion", action="store_true",
        help="always build the X__lc companion, even for already-lowercase columns",
    )
    p.add_argument(
        "--keep-history", action="store_true",
        help="keep old Lance versions (default: prune all but the current version)",
    )
    p.add_argument(
        "-j", "--jobs", type=int, default=4,
        help="datasets to prep in parallel when given a directory (default: 4). "
        "1 = serial with live per-step output; >1 buffers each dataset's output",
    )
    p.add_argument(
        "--clean", action=argparse.BooleanOptionalAction, default=True,
        help="first clean each dataset (flatten list cols, drop empty/duplicate rows, "
        "compact) before indexing -- DESTRUCTIVE (default: on; --no-clean to skip)",
    )
    p.add_argument(
        "--flatten", action=argparse.BooleanOptionalAction, default=True,
        help="clean pass: flatten list columns to ', '-joined strings (default: on)",
    )
    p.add_argument(
        "--dedup", action=argparse.BooleanOptionalAction, default=True,
        help="clean pass: delete normalized-duplicate prompt rows (default: on)",
    )
    p.add_argument(
        "--compact", action=argparse.BooleanOptionalAction, default=True,
        help="clean pass: compact fragments and purge old versions after deleting "
        "(default: on)",
    )
    p.add_argument(
        "--prompt-column", default=None,
        help="clean pass: the prompt column whose empty/duplicate rows are removed "
        "(default: the first of prompt/text/caption/description/value, else the first)",
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="preview what the clean pass would remove, without writing or building "
        "any indices",
    )
    p.set_defaults(func=cmd_prep)
