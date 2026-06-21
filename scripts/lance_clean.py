#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pylance", "pyarrow"]
# ///
"""Clean every Lance dataset under a directory (recursive): drop empty rows and,
by default, normalized-duplicate rows.

An *empty row* is one whose prompt column is NULL or, for a text column, blank
once stripped of surrounding spaces -- exactly the rows ``to_lancedb.py`` drops
at ingest and that the Quarry extension treats as unusable. Deleting them keeps
a random pick a plain ``LIMIT/OFFSET`` (a native O(1) Lance seek) instead of a
non-empty ``WHERE`` filter, which would defeat that pushdown and force a full
scan on every prompt. (Like DuckDB's ``trim``, Lance's only strips spaces, so a
tab/newline-only value is considered non-empty -- the same call the extension's
keep-test uses, so this stays consistent with what it sees as present.)

A *duplicate row* is one whose prompt, once normalized, was already seen earlier
in the same dataset. Normalization lowercases and drops every non-alphanumeric
character (so ``"Hello, World!"``, ``"hello world"`` and ``"HELLO  WORLD"`` all
collapse to ``helloworld``), so prompts differing only in case, punctuation or
spacing dedupe together. The first row of each normalized group is kept and the
rest deleted. Empty/whitespace-only prompts normalize to ``""`` and are left to
the empty-row pass instead of being deduped among themselves; dedup only applies
to a text prompt column. This is on by default; pass ``--no-dedup`` to skip it.

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
    python lance_clean.py <dir-or-dataset> [--dry-run] [--no-dedup] [--no-compact] [-w N]
    python lance_clean.py ./datasets
    python lance_clean.py ./datasets --dry-run
    python lance_clean.py ./datasets --no-dedup
    python lance_clean.py ./datasets --no-compact
    python lance_clean.py ./prompts.lance --prompt-column caption

Run it with the project venv:
    .venv/bin/python scripts/lance_clean.py ./datasets

or standalone with uv (deps are declared inline above):
    uv run scripts/lance_clean.py ./datasets
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


def normalize_prompt(value: str) -> str:
    """Collapse a prompt to its dedup key: lowercased with every non-alphanumeric character dropped.

    ``"Hello, World!"``, ``"hello world"`` and ``"HELLO  WORLD"`` all map to ``"helloworld"``, so prompts
    differing only in case, punctuation or spacing share a key. ``str.isalnum`` keeps Unicode letters/digits,
    so accented or non-Latin prompts dedupe sensibly too. An empty/whitespace-only prompt maps to ``""``.
    """
    return "".join(ch for ch in value.lower() if ch.isalnum())


def find_duplicate_rowids(ds: "lance.LanceDataset", col: str) -> list[int]:
    """Return the Lance ``_rowid``s of duplicate rows of ``col`` -- every row past the first in its normalized
    group. The first row of each group is kept. NULL prompts and prompts that normalize to ``""`` (empty or
    all-punctuation) are skipped so they fall to the empty-row pass instead of being deduped here.

    Streams the prompt column in batches so only the seen-key set (one normalized string per distinct prompt),
    not the whole column, is held at once.
    """
    seen: set[str] = set()
    dup_rowids: list[int] = []
    for batch in ds.scanner(columns=[col], with_row_id=True).to_batches():
        values = batch.column(col).to_pylist()
        rowids = batch.column("_rowid").to_pylist()
        for value, rowid in zip(values, rowids):
            if value is None:
                continue
            key = normalize_prompt(value)
            if not key:
                continue  # empty/whitespace-only/all-punctuation: left to the empty-row pass
            if key in seen:
                dup_rowids.append(rowid)
            else:
                seen.add(key)
    return dup_rowids


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


# A single ``_rowid IN (...)`` delete predicate per this many rowids; large delete batches keep the expression
# (and the number of delete calls) bounded without materializing one giant IN list for a duplicate-heavy set.
_DELETE_BATCH = 4096


def process_dataset(
    path: Path, override: str | None, dry_run: bool, compact: bool, dedup: bool
) -> dict:
    """Delete (or, with ``dry_run``, just count) the empty and normalized-duplicate rows of one dataset.

    Returns a result dict with the column used and row counts. Opens its own ``lance.dataset`` so it is safe
    to run from a worker thread. Empties are removed first; duplicates are then found over what remains so an
    emptied row is never also counted as the survivor of a duplicate group.
    """
    try:
        ds = lance.dataset(str(path))
    except Exception as exc:  # corrupt / incomplete / not a Lance dataset
        raise DatasetError(f"could not open dataset: {exc}") from exc

    columns = list(ds.schema.names)
    col = resolve_prompt_column(columns, override)
    if col is None:
        raise DatasetError("dataset has no columns")

    dtype = ds.schema.field(col).type
    pred = empty_row_predicate(col, dtype)
    total = ds.count_rows()
    # count_rows() over a scanner reading only the prompt column -- doesn't materialize row data.
    empty = ds.scanner(columns=[col], filter=pred).count_rows()

    result = {
        "column": col,
        "total": total,
        "empty": empty,
        "empty_removed": 0,
        "duplicate": 0,
        "duplicate_removed": 0,
    }

    # Empty-row pass. In --dry-run we don't delete, so dedup below scans the un-emptied dataset -- but its
    # normalize step skips the very rows this pass would remove (they normalize to ""), so the duplicate count
    # is the same either way and the two figures never double-count the same row.
    if empty and not dry_run:
        ds.delete(pred)
        result["empty_removed"] = total - ds.count_rows()

    # Duplicate-row pass. Normalization is a text operation, so it only applies to a text prompt column.
    if dedup and is_text_type(dtype):
        dup_rowids = find_duplicate_rowids(ds, col)
        result["duplicate"] = len(dup_rowids)
        if dup_rowids and not dry_run:
            for start in range(0, len(dup_rowids), _DELETE_BATCH):
                chunk = dup_rowids[start : start + _DELETE_BATCH]
                ds.delete("_rowid IN (" + ",".join(str(r) for r in chunk) + ")")
            result["duplicate_removed"] = len(dup_rowids)

    if compact and not dry_run and (result["empty_removed"] or result["duplicate_removed"]):
        # Rewrite fragments to drop the tombstoned rows, then purge the now-stale versions so the space is
        # actually reclaimed. cleanup_old_versions() defaults to an age threshold (~weeks) that protects
        # freshly written versions, so a no-arg call would be a no-op here; older_than=0 purges everything but
        # the latest version -- this is what makes --compact irreversible (the pre-delete versions are gone).
        ds.optimize.compact_files()
        ds.cleanup_old_versions(older_than=timedelta(0))
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Clean every Lance dataset under a directory: delete empty (NULL/blank prompt) rows and, by "
            "default, normalized-duplicate prompt rows."
        ),
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
        "--dedup",
        action=argparse.BooleanOptionalAction,
        default=True,
        help=(
            "also delete normalized-duplicate rows -- every prompt past the first whose lowercased, "
            "alphanumeric-only form was already seen in the dataset (on by default; --no-dedup removes "
            "only empty rows). Only applies to a text prompt column"
        ),
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
    total_empty = 0
    total_dup = 0
    failures: list[tuple[Path, str]] = []
    # Each dataset is opened in its own worker (process_dataset), so the work is thread-safe; we only print
    # from this (the main) thread to keep output lines from interleaving.
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(
                process_dataset, path, args.prompt_column, args.dry_run, args.compact, args.dedup
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
            # In --dry-run report what each pass found; otherwise what it actually removed.
            empties = r["empty"] if args.dry_run else r["empty_removed"]
            dups = r["duplicate"] if args.dry_run else r["duplicate_removed"]
            removed = empties + dups
            total_empty += empties
            total_dup += dups
            print(
                f"  {path} [{r['column']}]: {action} {empties} empty + {dups} duplicate row(s) "
                f"of {r['total']} ({r['total'] - removed} remain)"
            )

    verb = "would delete" if args.dry_run else "deleted"
    summary = (
        f"Done: {ok}/{len(datasets)} dataset(s) processed, "
        f"{verb} {total_empty} empty + {total_dup} duplicate row(s)"
    )
    if failures:
        summary += f"; {len(failures)} skipped"
    print(summary, file=sys.stderr)

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
