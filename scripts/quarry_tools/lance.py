"""`quarry lance` subcommands: clean and index standalone Lance datasets.

clean / index -- carried over from lance_clean.py and build_index.py. The index
command runs the clean pass first (as build_index did, via a sibling import); here
that is a normal intra-module call to ``process_dataset``. Heavy libraries (lance,
pyarrow, duckdb) are imported lazily inside the command functions.
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

from .common import quote_ident, quote_ident_backtick, quote_literal, workers_parent

# Conventionally named text columns, in preference order. Mirrors the extension's
# PromptColumnResolver (and to_lancedb) so the column we clean is the one it reads.
_PREFERRED_PROMPT_COLUMNS = ("prompt", "text", "caption", "description", "value")


class DatasetError(Exception):
    """A per-dataset problem that should be reported without aborting the batch."""


# ===========================================================================
# clean -- shared per-dataset logic (also reused by the index command)
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


def find_lance_datasets(root: Path) -> list[Path]:
    """Enumerate ``*.lance`` dataset directories under ``root`` the way the
    extension's DatasetScanner does."""
    if not root.exists():
        raise SystemExit(f"error: no such file or directory: {root}")
    if root.is_file():
        raise SystemExit(
            f"error: {root} is a file, not a directory of Lance datasets"
        )
    if root.name.lower().endswith(".lance"):
        return [root.resolve()]

    found: list[Path] = []
    for dirpath, dirnames, _files in os.walk(root):
        keep: list[str] = []
        for name in dirnames:
            if name.startswith("."):
                continue  # hidden: skip and don't descend
            if name.lower().endswith(".lance"):
                found.append((Path(dirpath) / name).resolve())  # dataset leaf
            else:
                keep.append(name)  # descend into it
        dirnames[:] = keep
    return sorted(found)


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
# lance clean
# ===========================================================================

_CLEAN_DESC = """\
Clean every Lance dataset under a directory (recursive): flatten list columns to
strings, drop empty rows and, by default, normalized-duplicate rows.

A list column (one whose Arrow type is a list) is flattened in place to a plain
string by joining its elements with ', ' (via Lance's array_to_string). This runs
first, before the empty and duplicate passes. On by default; pass --no-flatten to
leave lists as-is.

An empty row is one whose prompt column is NULL or, for a text column, blank once
stripped of surrounding spaces. Deleting them keeps a random pick a plain
LIMIT/OFFSET (a native O(1) Lance seek) instead of a non-empty WHERE filter.

A duplicate row is one whose prompt, once normalized (lowercased, non-alphanumerics
dropped), was already seen earlier in the same dataset. The first row of each group
is kept and the rest deleted. On by default; pass --no-dedup to skip it.

The prompt column is resolved per dataset the way the extension's
PromptColumnResolver does. Datasets are discovered the way DatasetScanner
enumerates them: *.lance dirs are leaves and hidden entries are skipped.

After flattening or deleting, fragments are compacted and old versions purged so
freed space is reclaimed. On by default; pass --no-compact to keep the soft-delete
tombstones (pre-delete version stays recoverable). Pass --dry-run to report how
many rows would be deleted without touching anything.

Usage:
    quarry lance clean <dir-or-dataset> [--dry-run] [--no-flatten] [--no-dedup] [--no-compact] [-w N]
    quarry lance clean ./datasets
    quarry lance clean ./datasets --dry-run
    quarry lance clean ./prompts.lance --prompt-column caption
"""


def cmd_clean(args) -> int:
    datasets = find_lance_datasets(Path(args.directory))
    if not datasets:
        print(f"No Lance datasets found under {args.directory}")
        return 0

    workers = max(1, min(args.workers, len(datasets)))
    action = "would delete" if args.dry_run else "deleted"
    flat_verb = "would flatten" if args.dry_run else "flattened"

    ok = 0
    total_empty = 0
    total_dup = 0
    total_flat = 0
    failures: list[tuple[Path, str]] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(
                process_dataset,
                path,
                args.prompt_column,
                args.dry_run,
                args.compact,
                args.dedup,
                args.flatten,
            ): path
            for path in datasets
        }
        for future in as_completed(futures):
            path = futures[future]
            try:
                r = future.result()
            except Exception as exc:  # DatasetError or an unexpected Lance error
                failures.append((path, str(exc)))
                print(f"  SKIP {path}: {exc}", file=sys.stderr)
                continue
            ok += 1
            flat = r["list_columns"] if args.dry_run else r["flattened"]
            empties = r["empty"] if args.dry_run else r["empty_removed"]
            dups = r["duplicate"] if args.dry_run else r["duplicate_removed"]
            removed = empties + dups
            total_flat += flat
            total_empty += empties
            total_dup += dups
            prefix = f"{flat_verb} {flat} list column(s); " if flat else ""
            print(
                f"  {path} [{r['column']}]: {prefix}{action} {empties} empty + "
                f"{dups} duplicate row(s) of {r['total']} "
                f"({r['total'] - removed} remain)"
            )

    verb = "would delete" if args.dry_run else "deleted"
    summary = (
        f"Done: {ok}/{len(datasets)} dataset(s) processed, "
        f"{flat_verb} {total_flat} list column(s), "
        f"{verb} {total_empty} empty + {total_dup} duplicate row(s)"
    )
    if failures:
        summary += f"; {len(failures)} skipped"
    print(summary, file=sys.stderr)

    return 1 if failures else 0


# ===========================================================================
# lance index
# ===========================================================================

_INDEX_DESC = """\
Build Quarry search indices on standalone Lance dataset(s).

For each chosen text column X this builds a Lance NGRAM scalar index so Quarry's
substring filters (contains) are pushed down by the DuckDB lance extension. Quarry
matches case-insensitively by lowercasing the search value, so:

  * if X is already fully lowercase, the NGRAM index is built in place on X;
  * otherwise a lowercased companion X__lc (= lower(X)) is added and indexed.

The original column X is never modified. Pass --always-companion to force the X__lc
form even for lowercase columns.

Before indexing, each dataset is first cleaned (flatten list columns, drop empty
and normalized-duplicate prompt rows, compact) so a list prompt column becomes
indexable and the index covers the final data. This is DESTRUCTIVE. Pass --no-clean
to skip it, the --no-flatten / --no-dedup / --no-compact toggles or --prompt-column
to tune it, or --dry-run to preview what cleaning would remove.

Auto-builds a BTREE scalar index on every declared-numeric column so numeric range
filters (+= / -=) push down. --no-btree disables this; --btree a,b adds extras.
--bitmap is also accepted for exact-equality queries.

Lance is versioned: by default this prunes everything but the current version
afterward; pass --keep-history to retain old versions.

When given a directory, datasets are indexed in parallel (-j / --jobs, default 4).

Usage:
    quarry lance index <dataset.lance | dir-searched-recursively> [options]
    quarry lance index ~/data/AIConfigs/Quarry
    quarry lance index ~/data/AIConfigs/Quarry -j 8
    quarry lance index ./nl/ --text-columns prompt,caption
    quarry lance index ./mixed/ --always-companion
    quarry lance index ~/data/AIConfigs/Quarry --dry-run
    quarry lance index ~/data/AIConfigs/Quarry --no-clean
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


def cmd_index(args) -> int:
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
        verb = "Previewed" if args.dry_run else "Indexed"
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

    p = subparsers.add_parser(
        "clean",
        help="clean Lance dataset(s): flatten lists, drop empty/duplicate rows",
        description=_CLEAN_DESC, formatter_class=raw,
        parents=[
            workers_parent(16, "how many datasets to process concurrently (default: 16)")
        ],
    )
    p.add_argument(
        "directory",
        help="a directory to scan recursively, or a single *.lance dataset directory",
    )
    p.add_argument(
        "--prompt-column", default=None,
        help="column whose NULL/blank rows are deleted (the prompt text column). "
        "Default: the first of prompt/text/caption/description/value present, else "
        "the first column",
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="report how many rows would be deleted from each dataset without "
        "changing anything",
    )
    p.add_argument(
        "--flatten", action=argparse.BooleanOptionalAction, default=True,
        help="first flatten every list column to a ', '-joined string (default: on)",
    )
    p.add_argument(
        "--dedup", action=argparse.BooleanOptionalAction, default=True,
        help="also delete normalized-duplicate prompt rows (default: on)",
    )
    p.add_argument(
        "--compact", action=argparse.BooleanOptionalAction, default=True,
        help="after deleting, compact fragments and purge old versions (default: on). "
        "Ignored in --dry-run",
    )
    p.set_defaults(func=cmd_clean)

    p = subparsers.add_parser(
        "index", help="build Quarry NGRAM/scalar indices on Lance dataset(s)",
        description=_INDEX_DESC, formatter_class=raw,
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
        help="datasets to index in parallel when given a directory (default: 4). "
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
    p.set_defaults(func=cmd_index)
