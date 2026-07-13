"""Shared helpers for the Quarry dataset-prep CLI.

Stdlib-only on purpose: this module is imported while building the argparse tree,
so it must never pull in duckdb / lance / pyarrow / huggingface_hub / visidata.
Each command imports those heavy libraries lazily, inside the function that needs
them, so `quarry --help` and the zero-dependency commands stay fast.
"""

from __future__ import annotations

import argparse
import glob
import os
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator

# --- Format inference -------------------------------------------------------

# The base extension -> logical format map shared by the tabular tools.
EXT_FORMAT = {
    ".parquet": "parquet",
    ".csv": "csv",
    ".jsonl": "jsonl",
    ".ndjson": "jsonl",
}

# The base map plus a Lance dataset directory (reorder_columns).
EXT_FORMAT_LANCE = {**EXT_FORMAT, ".lance": "lance"}

# The widest map: base plus .tsv, .json and Lance (show_columns).
EXT_FORMAT_SHOW = {**EXT_FORMAT, ".tsv": "csv", ".json": "json", ".lance": "lance"}


class FileError(Exception):
    """A per-file problem that should be reported without aborting the batch."""


def detect_format(
    path: Path,
    override: str | None,
    *,
    ext_map: dict[str, str],
    formats,
    batch: bool = False,
    hint: str | None = None,
    include_path: bool = False,
) -> str:
    """Return the logical format for ``path``.

    ``override`` (a ``--format`` value, already validated by argparse ``choices``)
    wins; otherwise the format is inferred from the file extension via ``ext_map``.
    On an uninferrable extension a *batch* tool raises ``FileError`` (so one bad
    file is skipped and the rest still run) while a single-file tool raises
    ``SystemExit``. ``hint`` is the ``pass --format (...)`` suggestion list;
    ``include_path`` appends the path to the message (append_files does).
    """
    if override:
        fmt = override.lower()
        if fmt not in formats:
            raise SystemExit(
                f"error: unknown --format {override!r} "
                f"(choose from: {', '.join(formats)})"
            )
        return fmt
    fmt = ext_map.get(path.suffix.lower())
    if fmt is None:
        hint_str = hint if hint is not None else "|".join(formats)
        loc = f" ({path})" if include_path else ""
        msg = (
            f"cannot infer format from extension {path.suffix!r}{loc}; "
            f"pass --format ({hint_str})"
        )
        if batch:
            raise FileError(msg)
        raise SystemExit(f"error: {msg}")
    return fmt


# --- SQL quoting ------------------------------------------------------------


def quote_ident(name: str) -> str:
    """Double-quote a SQL identifier (DuckDB / standard SQL), escaping quotes."""
    return '"' + name.replace('"', '""') + '"'


def quote_literal(value: str) -> str:
    """Single-quote a SQL string literal, doubling embedded single quotes."""
    return "'" + str(value).replace("'", "''") + "'"


def quote_ident_backtick(name: str) -> str:
    """Backtick-quote an identifier for Lance / DataFusion expression engines.

    Lance treats double quotes as a *string literal* (so ``lower("prompt")`` is the
    constant 'prompt'); backticks are its identifier quote and handle mixed-case /
    odd names (spaces, reserved words) correctly.
    """
    return "`" + name.replace("`", "``") + "`"


# --- DuckDB reader / writer clauses -----------------------------------------


def read_relation_sql(fmt: str, path_param: str = "?") -> str:
    """Build the FROM-clause reader call for the given format.

    ``path_param`` is either a ``?`` placeholder (for a parameterized DESCRIBE) or
    a quoted string literal (for a COPY). ``json`` reads an array/records file with
    auto format; ``jsonl`` reads newline-delimited JSON.
    """
    if fmt == "jsonl":
        return f"read_json({path_param}, format='newline_delimited')"
    if fmt == "json":
        return f"read_json({path_param}, format='auto')"
    if fmt == "csv":
        return f"read_csv_auto({path_param})"
    return f"read_parquet({path_param})"


def copy_options(fmt: str) -> str:
    """DuckDB COPY ... (options) for the given output format."""
    return {
        "parquet": "FORMAT PARQUET",
        "csv": "FORMAT CSV, HEADER",
        "jsonl": "FORMAT JSON",  # newline-delimited (ARRAY false) by default
    }[fmt]


# --- File / pattern resolution ----------------------------------------------


def resolve_files(pattern: str, *, include_lance: bool = False) -> list[Path]:
    """Expand a path-or-wildcard into a sorted list of existing targets.

    A target is an ordinary file, plus (with ``include_lance``) a Lance dataset
    directory (``*.lance``); other directories are ignored so a wildcard never
    picks up plain folders.
    """
    matches = sorted(glob.glob(pattern, recursive=True))
    if include_lance:
        files = [
            Path(m)
            for m in matches
            if os.path.isfile(m)
            or (os.path.isdir(m) and m.lower().endswith(".lance"))
        ]
    else:
        files = [Path(m) for m in matches if os.path.isfile(m)]
    if not files:
        if glob.has_magic(pattern):
            raise SystemExit(f"error: no files match pattern: {pattern}")
        raise SystemExit(f"error: no such file: {pattern}")
    return files


# --- Semicolon / comma list parsers -----------------------------------------


def parse_columns(raw: str) -> list[str]:
    """Split a comma-separated column list, trimming blanks and de-duping."""
    seen: dict[str, None] = {}
    for part in raw.split(","):
        col = part.strip()
        if col and col not in seen:
            seen[col] = None
    return list(seen)


def parse_renames(
    raw: str, default_target: str = "prompt"
) -> list[tuple[str, str]]:
    """Parse 'old=new;old2=new2' into ordered (old, new) pairs.

    Splits on ';' then the first '=' of each chunk. Blank chunks are skipped. A
    bare chunk with no '=' (e.g. ``summary_en``) defaults its target to
    ``default_target``. Rejects malformed chunks (an empty ``old``, or an explicit
    '=' with an empty target) and an ``old`` named more than once (case-insensitive).
    """
    pairs: list[tuple[str, str]] = []
    seen_old: dict[str, None] = {}
    for chunk in raw.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        old, sep, new = chunk.partition("=")
        old = old.strip()
        new = new.strip()
        if not old or (sep and not new):
            raise SystemExit(
                f"error: bad rename {chunk!r}, expected 'old=new' or a bare "
                f"column name (renamed to {default_target!r})"
            )
        if not sep:
            new = default_target
        key = old.lower()
        if key in seen_old:
            raise SystemExit(f"error: column {old!r} renamed more than once")
        seen_old[key] = None
        pairs.append((old, new))
    return pairs


def parse_extractions(raw: str) -> list[tuple[str, str]]:
    """Parse 'column=path;column2=path2' into ordered (column, path) pairs.

    Splits on ';' then the first '=' of each chunk. Blank chunks are skipped.
    Rejects malformed chunks (no '=', or an empty side) and a column named more
    than once (case-insensitively).
    """
    pairs: list[tuple[str, str]] = []
    seen: dict[str, None] = {}
    for chunk in raw.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        col, sep, path = chunk.partition("=")
        col = col.strip()
        path = path.strip()
        if not sep or not col or not path:
            raise SystemExit(
                f"error: bad extraction {chunk!r}, expected 'column=path'"
            )
        key = col.lower()
        if key in seen:
            raise SystemExit(f"error: column {col!r} reduced more than once")
        seen[key] = None
        pairs.append((col, path))
    return pairs


# --- Atomic writes ----------------------------------------------------------


@contextmanager
def atomic_output(dest: Path) -> Iterator[Path]:
    """Yield a temp path beside ``dest``; on clean exit atomically replace ``dest``.

    Creates a ``.{dest.name}.*.tmp`` file in ``dest``'s directory, yields its path
    for the caller to write into, then ``os.replace``s it onto ``dest`` -- so a
    failure mid-write can't corrupt ``dest`` (the temp file is unlinked instead).
    """
    fd, tmp_name = tempfile.mkstemp(
        dir=str(dest.parent), prefix=f".{dest.name}.", suffix=".tmp"
    )
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        yield tmp_path
        os.replace(tmp_path, dest)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


# --- Concurrent per-item runner ---------------------------------------------


def as_pool_results(
    fn: Callable, items: list, workers: int
) -> Iterator[tuple]:
    """Run ``fn(item)`` across a thread pool; yield ``(item, result, exc)`` as each
    completes.

    ``result`` is ``None`` when ``exc`` is set (``fn`` raised); ``exc`` is ``None``
    on success. The worker count is clamped to ``[1, len(items)]``. The caller
    handles printing and failure tallying, and (like the original scripts) prints
    only from the calling thread so output lines never interleave.
    """
    workers = max(1, min(workers, len(items)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fn, item): item for item in items}
        for future in as_completed(futures):
            item = futures[future]
            try:
                yield item, future.result(), None
            except Exception as exc:  # a per-item failure; keep the batch going
                yield item, None, exc


# --- Shared argparse parent parsers -----------------------------------------


def workers_parent(default: int, help: str) -> argparse.ArgumentParser:
    """A parent parser contributing ``-w/--workers`` with the given default/help."""
    p = argparse.ArgumentParser(add_help=False)
    p.add_argument("-w", "--workers", type=int, default=default, help=help)
    return p


def format_parent(
    choices,
    help: str = "override the format instead of inferring it from the extension",
) -> argparse.ArgumentParser:
    """A parent parser contributing ``--format`` with the given choices/help."""
    p = argparse.ArgumentParser(add_help=False)
    p.add_argument(
        "--format", dest="format", choices=choices, default=None, help=help
    )
    return p


def dry_run_parent(help: str) -> argparse.ArgumentParser:
    """A parent parser contributing ``--dry-run`` with the given help."""
    p = argparse.ArgumentParser(add_help=False)
    p.add_argument("--dry-run", action="store_true", help=help)
    return p
