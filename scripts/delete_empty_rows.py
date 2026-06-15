#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pylance", "pyarrow"]
# ///
"""Delete empty rows from every Lance dataset under a directory (recursive).

An *empty row* is one whose prompt column is NULL or, for a text column, blank
once stripped of surrounding spaces -- exactly the rows ``to_lancedb.py`` drops
at ingest and that the Quarry extension treats as unusable. Deleting them keeps
a random pick a plain ``LIMIT/OFFSET`` (a native O(1) Lance seek) instead of a
non-empty ``WHERE`` filter, which would defeat that pushdown and force a full
scan on every prompt. (Like DuckDB's ``trim``, Lance's only strips spaces, so a
tab/newline-only value is considered non-empty -- the same call the extension's
keep-test uses, so this stays consistent with what it sees as present.)

The prompt column is resolved per dataset the way the extension's
PromptColumnResolver does: an explicit ``--prompt-column`` if given, else the
first of prompt/text/caption/description/value present (case-insensitive), else
the first column. For a non-text prompt column only NULL counts as empty.

Datasets are discovered the way the extension's DatasetScanner enumerates them:
directories named ``*.lance`` are datasets and are treated as leaves (we do not
descend into them, so their internal fragment files are never mistaken for
datasets), and hidden entries (names starting with ``.``) are skipped -- so tool
caches such as ``.cache/huggingface/upload/*.lance``, which hold incomplete,
unopenable datasets, are never touched. The argument may also be a single
``*.lance`` directory.

After deleting, fragments are compacted and old versions purged so the freed
space is actually reclaimed and scans no longer carry the tombstones (Lance
deletes are otherwise soft -- they only write deletion vectors). This is on by
default; pass ``--no-compact`` to skip it and leave the soft-delete tombstones,
which keeps the pre-delete version recoverable (``lance.dataset(path,
version=N)``) at the cost of not reclaiming the space.

Datasets are processed concurrently (16 at a time by default, see ``-w``) and
independently: each opens its own dataset, so a failure on one (e.g. a corrupt
or empty-schema dataset) is reported while the rest still run. Pass
``--dry-run`` to report how many rows *would* be deleted without touching
anything.

Usage:
    python delete_empty_rows.py <dir-or-dataset> [--dry-run] [--no-compact] [-w N]
    python delete_empty_rows.py ./datasets
    python delete_empty_rows.py ./datasets --dry-run
    python delete_empty_rows.py ./datasets --no-compact
    python delete_empty_rows.py ./prompts.lance --prompt-column caption

Run it with the project venv:
    .venv/bin/python scripts/delete_empty_rows.py ./datasets

or standalone with uv (deps are declared inline above):
    uv run scripts/delete_empty_rows.py ./datasets
"""

from __future__ import annotations

import argparse
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import timedelta
from pathlib import Path

import lance
import pyarrow as pa

# Conventionally named text columns, in preference order. Mirrors the extension's PromptColumnResolver (and
# to_lancedb.py) so the column we strip blanks from is the one the extension later reads prompts from.
_PREFERRED_PROMPT_COLUMNS = ("prompt", "text", "caption", "description", "value")


class DatasetError(Exception):
    """A per-dataset problem that should be reported without aborting the batch."""


def quote_ident(name: str) -> str:
    """Backtick-quote a SQL identifier for a Lance filter, escaping embedded backticks.

    Lance's expression engine quotes identifiers with backticks; double quotes denote a string literal there,
    so a double-quoted column name silently matches nothing. Backticks keep odd names (spaces, reserved
    words) working.
    """
    return "`" + name.replace("`", "``") + "`"


def resolve_prompt_column(columns: list[str], override: str | None) -> str | None:
    """Pick the column whose blank rows count as empty, mirroring the extension's PromptColumnResolver: an
    explicit ``override`` if given, else the first conventionally named text column, else the first column.
    Returns ``None`` only for an empty schema. Matching is case-insensitive; the dataset's own casing wins."""
    if override:
        for col in columns:
            if col.lower() == override.lower():
                return col
        raise DatasetError(
            f"--prompt-column {override!r} not found; columns: {', '.join(columns) or '(none)'}"
        )
    by_lower = {col.lower(): col for col in columns}
    for preferred in _PREFERRED_PROMPT_COLUMNS:
        if preferred in by_lower:
            return by_lower[preferred]
    return columns[0] if columns else None


def is_text_type(dtype: pa.DataType) -> bool:
    """True for the Arrow string variants we can trim (utf8 / large_utf8 / string_view)."""
    return (
        pa.types.is_string(dtype)
        or pa.types.is_large_string(dtype)
        or pa.types.is_string_view(dtype)
    )


def empty_row_predicate(col: str, dtype: pa.DataType) -> str:
    """Lance filter matching empty rows of ``col``: NULL always, plus space-only for a text column.

    ``length(trim(col)) = 0`` is the negation of the ``length(trim(col)) > 0`` keep-test to_lancedb.py and the
    extension apply, so the same rows are considered empty. NULL needs its own clause; ``trim`` can't see a
    non-text column, so for those only NULL is empty.
    """
    ident = quote_ident(col)
    if is_text_type(dtype):
        return f"{ident} IS NULL OR length(trim({ident})) = 0"
    return f"{ident} IS NULL"


def find_lance_datasets(root: Path) -> list[Path]:
    """Enumerate ``*.lance`` dataset directories under ``root`` the way the extension's DatasetScanner does:
    ``.lance`` dirs are leaves (not descended into) and hidden entries (names starting with ``.``) are
    skipped. ``root`` itself may be a single ``*.lance`` directory. Returns sorted absolute paths."""
    if not root.exists():
        raise SystemExit(f"error: no such file or directory: {root}")
    if root.is_file():
        raise SystemExit(f"error: {root} is a file, not a directory of Lance datasets")
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


def process_dataset(path: Path, override: str | None, dry_run: bool, compact: bool) -> dict:
    """Delete (or, with ``dry_run``, just count) the empty rows of one dataset.

    Returns a result dict with the column used and row counts. Opens its own ``lance.dataset`` so it is safe
    to run from a worker thread.
    """
    try:
        ds = lance.dataset(str(path))
    except Exception as exc:  # corrupt / incomplete / not a Lance dataset
        raise DatasetError(f"could not open dataset: {exc}") from exc

    columns = list(ds.schema.names)
    col = resolve_prompt_column(columns, override)
    if col is None:
        raise DatasetError("dataset has no columns")

    pred = empty_row_predicate(col, ds.schema.field(col).type)
    total = ds.count_rows()
    # count_rows() over a scanner reading only the prompt column -- doesn't materialize row data.
    empty = ds.scanner(columns=[col], filter=pred).count_rows()

    result = {"column": col, "total": total, "empty": empty, "removed": 0}
    if empty == 0 or dry_run:
        return result

    ds.delete(pred)
    result["removed"] = total - ds.count_rows()
    if compact:
        # Rewrite fragments to drop the tombstoned rows, then purge the now-stale versions so the space is
        # actually reclaimed. cleanup_old_versions() defaults to an age threshold (~weeks) that protects
        # freshly written versions, so a no-arg call would be a no-op here; older_than=0 purges everything but
        # the latest version -- this is what makes --compact irreversible (the pre-delete version is gone).
        ds.optimize.compact_files()
        ds.cleanup_old_versions(older_than=timedelta(0))
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Delete empty (NULL/blank prompt) rows from every Lance dataset under a directory.",
    )
    parser.add_argument(
        "directory",
        help="a directory to scan recursively, or a single *.lance dataset directory",
    )
    parser.add_argument(
        "--prompt-column",
        default=None,
        help=(
            "column whose NULL/blank rows are deleted (the prompt text column). Default: the first of "
            "prompt/text/caption/description/value present, else the first column -- mirroring how the "
            "Quarry extension resolves the prompt column"
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report how many rows would be deleted from each dataset without changing anything",
    )
    parser.add_argument(
        "--compact",
        action=argparse.BooleanOptionalAction,
        default=True,
        help=(
            "after deleting, compact fragments and purge old versions so freed space is reclaimed "
            "(on by default; --no-compact leaves Lance's soft-delete tombstones in place, keeping the "
            "pre-delete version recoverable). Ignored in --dry-run"
        ),
    )
    parser.add_argument(
        "-w",
        "--workers",
        type=int,
        default=16,
        help="how many datasets to process concurrently (default: 16)",
    )
    args = parser.parse_args(argv)

    datasets = find_lance_datasets(Path(args.directory))
    if not datasets:
        print(f"No Lance datasets found under {args.directory}")
        return 0

    workers = max(1, min(args.workers, len(datasets)))
    action = "would delete" if args.dry_run else "deleted"

    ok = 0
    total_removed = 0
    failures: list[tuple[Path, str]] = []
    # Each dataset is opened in its own worker (process_dataset), so the work is thread-safe; we only print
    # from this (the main) thread to keep output lines from interleaving.
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(process_dataset, path, args.prompt_column, args.dry_run, args.compact): path
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
            n = r["empty"] if args.dry_run else r["removed"]
            total_removed += n
            print(
                f"  {path} [{r['column']}]: {action} {n} empty row(s) "
                f"of {r['total']} ({r['total'] - n} remain)"
            )

    verb = "would delete" if args.dry_run else "deleted"
    summary = f"Done: {ok}/{len(datasets)} dataset(s) processed, {verb} {total_removed} empty row(s)"
    if failures:
        summary += f"; {len(failures)} skipped"
    print(summary, file=sys.stderr)

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
