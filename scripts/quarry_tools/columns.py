"""`quarry columns` subcommands: inspect and reshape a file's columns.

show / rename / remove / reorder / name / reduce-json -- each preserved verbatim
from the original standalone scripts (show_columns.py, rename_columns.py, ...).
Heavy libraries (duckdb, lance) are imported lazily inside the command functions.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .common import (
    EXT_FORMAT,
    EXT_FORMAT_LANCE,
    EXT_FORMAT_SHOW,
    FileError,
    as_pool_results,
    atomic_output,
    copy_options,
    detect_format,
    format_parent,
    parse_columns,
    parse_extractions,
    parse_renames,
    quote_ident,
    quote_literal,
    read_relation_sql,
    resolve_files,
    workers_parent,
)

_BATCH_WORKERS_HELP = "how many files to process concurrently (default: 16)"

# ===========================================================================
# columns show
# ===========================================================================

_SHOW_DESC = """\
Print the column names of a data file as a single comma-delimited line.

Supports Parquet, CSV/TSV, JSONL/NDJSON, JSON (array or records), and Lance
datasets (a *.lance directory). The format is inferred from the extension;
override it with --format for odd names.

Output is just the names, e.g. id,name,score,ok -- no types, one line.

Usage:
    quarry columns show <file>
    quarry columns show data.parquet
    quarry columns show prompts.lance
    quarry columns show weird_name --format csv
"""

_SHOW_FORMATS = ("parquet", "csv", "jsonl", "json", "lance")


def cmd_show(args) -> int:
    import duckdb

    path = Path(args.file)
    fmt = detect_format(
        path,
        args.format,
        ext_map=EXT_FORMAT_SHOW,
        formats=_SHOW_FORMATS,
        hint="parquet|csv|jsonl|json|lance",
    )

    # A Lance dataset is a directory, not a file, and is read with pylance rather
    # than a DuckDB reader -- mirroring the lance tools.
    if fmt == "lance":
        if not path.is_dir():
            raise SystemExit(f"error: no such Lance dataset: {path}")
        import lance  # imported lazily so non-Lance use needs no pylance

        try:
            names = list(lance.dataset(str(path)).schema.names)
        except Exception as exc:  # corrupt / incomplete / not a Lance dataset
            raise SystemExit(f"error: could not read {path} as lance: {exc}")
        print(",".join(names))
        return 0

    if not path.is_file():
        raise SystemExit(f"error: no such file: {path}")

    reader = read_relation_sql(fmt, quote_literal(str(path)))

    con = duckdb.connect()
    try:
        rows = con.execute(f"DESCRIBE SELECT * FROM {reader}").fetchall()
    except duckdb.Error as exc:
        raise SystemExit(f"error: could not read {path} as {fmt}: {exc}")
    finally:
        con.close()

    names = [r[0] for r in rows]
    print(",".join(names))
    return 0


# ===========================================================================
# columns rename
# ===========================================================================

_RENAME_DESC = """\
Rename columns in Parquet/CSV/JSONL file(s) in place, preserving column order.

Renames are given as a semicolon-separated list of old=new pairs:

    Prompt=prompt;foo=bar;qwe=tags

As a shorthand, a bare column name with no '=' is renamed to 'prompt' -- so
'summary_en' means the same as 'summary_en=prompt'. (This is the common case of
pointing the extension at whichever column holds the prompt text.)

Each 'old' is matched against the file's columns case-insensitively (DuckDB
identifiers are), and renamed to 'new' exactly as written. Columns not named are
left untouched, and every column keeps its existing position -- only the header
names change.

The 'file' argument may be a single path or a shell-style wildcard pattern (*, ?,
[...], **). Each matching file is read, its columns are renamed, and the result is
written back to the same path in the same format. Writing goes to a temporary file
first, then atomically replaces the original. A file that already has the requested
names is left untouched. Files are processed concurrently (16 at a time by default,
see -w) and independently: a failure on one is reported and the rest still run.

Quote the mapping so the shell passes the ';' through:

    quarry columns rename data.parquet 'Prompt=prompt;foo=bar'
    quarry columns rename data.parquet summary_en               # -> summary_en=prompt
    quarry columns rename '000*.parquet' 'Prompt=prompt'
    quarry columns rename 'shards/*.jsonl' 'text=prompt' --format jsonl
    quarry columns rename '*.parquet' 'a=b' -w 8
"""

_TABULAR_CHOICES = sorted(("parquet", "csv", "jsonl"))


def _plan_renames(existing, renames):
    """Compute the per-column SELECT parts and the resulting column names.

    Matching is case-insensitive against ``existing``; new names are used exactly
    as given. Raises ``FileError`` if an ``old`` is absent or the renames would
    collide. Returns (select_parts, new_names) in the original column order.
    """
    existing_lower = {name.lower(): name for name in existing}
    missing = [old for old, _ in renames if old.lower() not in existing_lower]
    if missing:
        raise FileError(
            f"column(s) not found: {', '.join(missing)} "
            f"(available: {', '.join(existing)})"
        )
    rename_map = {old.lower(): new for old, new in renames}

    select_parts: list[str] = []
    new_names: list[str] = []
    for col in existing:
        new = rename_map.get(col.lower())
        if new is None:
            select_parts.append(quote_ident(col))
            new_names.append(col)
        else:
            select_parts.append(f"{quote_ident(col)} AS {quote_ident(new)}")
            new_names.append(new)

    lowered = [n.lower() for n in new_names]
    dupes = sorted({n for n in lowered if lowered.count(n) > 1})
    if dupes:
        raise FileError(
            f"rename would create duplicate column name(s): {', '.join(dupes)}"
        )
    return select_parts, new_names


def _rename_file(path, renames, fmt_override):
    import duckdb

    fmt = detect_format(
        path, fmt_override, ext_map=EXT_FORMAT, formats=("parquet", "csv", "jsonl"),
        batch=True, hint="parquet|csv|jsonl",
    )

    con = duckdb.connect()
    try:
        described = con.execute(
            f"DESCRIBE SELECT * FROM {read_relation_sql(fmt)}", [str(path)]
        ).fetchall()
        existing = [row[0] for row in described]

        select_parts, new_names = _plan_renames(existing, renames)
        rename_map = {old.lower(): new for old, new in renames}
        applied = [
            (col, rename_map[col.lower()])
            for col in existing
            if col.lower() in rename_map
        ]
        if new_names == existing:
            return fmt, applied, False

        select_list = ", ".join(select_parts)
        with atomic_output(path) as tmp_path:
            con.execute(
                f"COPY (SELECT {select_list} "
                f"FROM {read_relation_sql(fmt, quote_literal(str(path)))}) "
                f"TO {quote_literal(str(tmp_path))} ({copy_options(fmt)})"
            )
    finally:
        con.close()

    return fmt, applied, True


def cmd_rename(args) -> int:
    renames = parse_renames(args.renames)
    if not renames:
        raise SystemExit("error: no renames given")

    files = resolve_files(args.file)

    changed = 0
    unchanged = 0
    failures: list[tuple[Path, str]] = []
    for path, result, exc in as_pool_results(
        lambda p: _rename_file(p, renames, args.format), files, args.workers
    ):
        if exc is not None:
            failures.append((path, str(exc)))
            print(f"  SKIP {path}: {exc}", file=sys.stderr)
            continue
        fmt, applied, was_changed = result
        mapping = ", ".join(f"{old} -> {new}" for old, new in applied)
        if was_changed:
            changed += 1
            print(f"  {path} [{fmt}]: renamed {mapping}")
        else:
            unchanged += 1
            print(f"  {path} [{fmt}]: already named as requested ({mapping})")

    if len(files) > 1 or failures:
        pairs = "; ".join(f"{old}={new}" for old, new in renames)
        summary = (
            f"Done: {changed}/{len(files)} file(s) renamed"
            f"{f', {unchanged} unchanged' if unchanged else ''}"
            f", renames: {pairs}"
        )
        if failures:
            summary += f"; {len(failures)} skipped"
        print(summary, file=sys.stderr)

    return 1 if failures else 0


# ===========================================================================
# columns remove
# ===========================================================================

_REMOVE_DESC = """\
Remove one or more columns from Parquet/CSV/JSONL file(s) in place.

The 'file' argument may be a single path or a shell-style wildcard pattern (*, ?,
[...], **). Each matching file is read, the named column(s) are dropped, and the
result is written back to the same path in the same format. Writing goes to a
temporary file first, then atomically replaces the original. Files are processed
concurrently (16 at a time by default, see -w) and independently: a failure on
one is reported and the rest still run.

Quote the pattern so the shell passes it through:

    quarry columns remove '000*.parquet' price,notes
    quarry columns remove data.parquet price,notes
    quarry columns remove 'shards/*.jsonl' id --format jsonl
    quarry columns remove '*.parquet' notes -w 8
"""


def _remove_file(path, targets, fmt_override):
    import duckdb

    fmt = detect_format(
        path, fmt_override, ext_map=EXT_FORMAT, formats=("parquet", "csv", "jsonl"),
        batch=True, hint="parquet|csv|jsonl",
    )

    con = duckdb.connect()
    try:
        described = con.execute(
            f"DESCRIBE SELECT * FROM {read_relation_sql(fmt)}", [str(path)]
        ).fetchall()
        existing = [row[0] for row in described]
        existing_lower = {name.lower(): name for name in existing}

        missing = [c for c in targets if c.lower() not in existing_lower]
        if missing:
            raise FileError(
                f"column(s) not found: {', '.join(missing)} "
                f"(available: {', '.join(existing)})"
            )

        remove_lower = {c.lower() for c in targets}
        remaining = [n for n in existing if n.lower() not in remove_lower]
        if not remaining:
            raise FileError(
                f"refusing to remove every column "
                f"({len(existing)} requested, 0 would remain)"
            )

        exclude = ", ".join(quote_ident(existing_lower[c.lower()]) for c in targets)
        with atomic_output(path) as tmp_path:
            con.execute(
                f"COPY (SELECT * EXCLUDE ({exclude}) "
                f"FROM {read_relation_sql(fmt, quote_literal(str(path)))}) "
                f"TO {quote_literal(str(tmp_path))} ({copy_options(fmt)})"
            )
    finally:
        con.close()

    removed = [existing_lower[c.lower()] for c in targets]
    return fmt, removed, remaining


def cmd_remove(args) -> int:
    targets = parse_columns(args.columns)
    if not targets:
        raise SystemExit("error: no column names given")

    files = resolve_files(args.file)

    ok = 0
    failures: list[tuple[Path, str]] = []
    for path, result, exc in as_pool_results(
        lambda p: _remove_file(p, targets, args.format), files, args.workers
    ):
        if exc is not None:
            failures.append((path, str(exc)))
            print(f"  SKIP {path}: {exc}", file=sys.stderr)
            continue
        fmt, removed, remaining = result
        ok += 1
        print(
            f"  {path} [{fmt}]: removed {', '.join(removed)} "
            f"-> {len(remaining)} column(s) remain ({', '.join(remaining)})"
        )

    if len(files) > 1 or failures:
        summary = (
            f"Done: {ok}/{len(files)} file(s) updated, removed: {', '.join(targets)}"
        )
        if failures:
            summary += f"; {len(failures)} skipped"
        print(summary, file=sys.stderr)

    return 1 if failures else 0


# ===========================================================================
# columns reorder
# ===========================================================================

_REORDER_DESC = """\
Move named columns to the front of Parquet/CSV/JSONL/Lance file(s) in place.

Given a file and a comma-separated column order, the named columns are placed --
in exactly the order given -- at the front of the file; every other column keeps
its existing relative order behind them. For a file with columns
id,prompt,foo,bar,baz, passing prompt,foo yields prompt,foo,id,bar,baz.

The 'file' argument may be a single path or a shell-style wildcard pattern (*, ?,
[...], **). A Lance dataset is a *.lance directory and is matched too. Each match
is read, its columns are reordered, and the result is written back to the same
path in the same format. A file already in the requested order is left untouched.
Files are processed concurrently (16 at a time by default, see -w) and
independently: a failure on one is reported and the rest still run.

Quote the pattern so the shell passes it through:

    quarry columns reorder data.parquet prompt,foo
    quarry columns reorder prompts.lance prompt,foo
    quarry columns reorder '000*.parquet' prompt,foo
    quarry columns reorder 'shards/*.jsonl' text --format jsonl
    quarry columns reorder '*.parquet' prompt -w 8
"""

_REORDER_CHOICES = sorted(("parquet", "csv", "jsonl", "lance"))


def _plan_order(existing, front):
    """Compute the new column order: ``front`` (in the given order) then the rest.

    Matching is case-insensitive; returned names are the file's canonical casing.
    Raises ``FileError`` if any front column is missing. Returns
    (front_canonical, new_order).
    """
    existing_lower = {name.lower(): name for name in existing}
    missing = [c for c in front if c.lower() not in existing_lower]
    if missing:
        raise FileError(
            f"column(s) not found: {', '.join(missing)} "
            f"(available: {', '.join(existing)})"
        )
    front_canonical = [existing_lower[c.lower()] for c in front]
    front_lower = {c.lower() for c in front}
    rest = [n for n in existing if n.lower() not in front_lower]
    return front_canonical, front_canonical + rest


def _reorder_lance(path, front):
    import os
    import shutil
    import tempfile

    import lance  # imported lazily so non-Lance use needs no pylance

    try:
        ds = lance.dataset(str(path))
    except Exception as exc:  # corrupt / incomplete / not a Lance dataset
        raise FileError(f"could not open dataset: {exc}") from exc

    existing = list(ds.schema.names)
    _, new_order = _plan_order(existing, front)
    if new_order == existing:
        return "lance", new_order, False

    work = Path(tempfile.mkdtemp(dir=str(path.parent), prefix=f".{path.name}."))
    new_ds = work / path.name
    backup = work / (path.name + ".bak")
    try:
        lance.write_dataset(ds.scanner(columns=new_order).to_reader(), str(new_ds))
        os.replace(path, backup)  # move the original aside
        try:
            os.replace(new_ds, path)  # move the new dataset into place
        except BaseException:
            os.replace(backup, path)  # restore the original on failure
            raise
    except BaseException:
        shutil.rmtree(work, ignore_errors=True)
        raise
    shutil.rmtree(work, ignore_errors=True)  # removes the leftover backup too

    return "lance", new_order, True


def _reorder_file(path, front, fmt_override):
    import duckdb

    fmt = detect_format(
        path, fmt_override, ext_map=EXT_FORMAT_LANCE,
        formats=("parquet", "csv", "jsonl", "lance"), batch=True,
        hint="parquet|csv|jsonl|lance",
    )
    if fmt == "lance":
        return _reorder_lance(path, front)

    con = duckdb.connect()
    try:
        described = con.execute(
            f"DESCRIBE SELECT * FROM {read_relation_sql(fmt)}", [str(path)]
        ).fetchall()
        existing = [row[0] for row in described]

        _, new_order = _plan_order(existing, front)
        if new_order == existing:
            return fmt, new_order, False

        select_list = ", ".join(quote_ident(n) for n in new_order)
        with atomic_output(path) as tmp_path:
            con.execute(
                f"COPY (SELECT {select_list} "
                f"FROM {read_relation_sql(fmt, quote_literal(str(path)))}) "
                f"TO {quote_literal(str(tmp_path))} ({copy_options(fmt)})"
            )
    finally:
        con.close()

    return fmt, new_order, True


def cmd_reorder(args) -> int:
    front = parse_columns(args.columns)
    if not front:
        raise SystemExit("error: no column names given")

    files = resolve_files(args.file, include_lance=True)

    changed = 0
    unchanged = 0
    failures: list[tuple[Path, str]] = []
    for path, result, exc in as_pool_results(
        lambda p: _reorder_file(p, front, args.format), files, args.workers
    ):
        if exc is not None:
            failures.append((path, str(exc)))
            print(f"  SKIP {path}: {exc}", file=sys.stderr)
            continue
        fmt, new_order, was_changed = result
        if was_changed:
            changed += 1
            print(f"  {path} [{fmt}]: reordered -> {', '.join(new_order)}")
        else:
            unchanged += 1
            print(f"  {path} [{fmt}]: already in order ({', '.join(new_order)})")

    if len(files) > 1 or failures:
        summary = (
            f"Done: {changed}/{len(files)} file(s) reordered"
            f"{f', {unchanged} already in order' if unchanged else ''}"
            f", front: {', '.join(front)}"
        )
        if failures:
            summary += f"; {len(failures)} skipped"
        print(summary, file=sys.stderr)

    return 1 if failures else 0


# ===========================================================================
# columns name
# ===========================================================================

_NAME_DESC = """\
Give a name to the single column of a file whose header was never defined.

Some single-column data files (e.g. DamarJati.SD-Prompts.parquet) were written
with no header, so the first value ended up masquerading as the column name.
Reading them shows a "column" whose name is really a row of data.

This command takes the file and one column name and rewrites it with a proper,
single named column. The orphaned value sitting in the name slot is recovered as
the first row, so no data is lost.

What counts as "orphaned" depends on the format:
  * parquet / csv -- the reader absorbs the first value into the column name, so
    that value is prepended back as the first row (235 -> 236 rows).
  * jsonl -- bare values read as a placeholder column ('json') with every value
    already present, so the column is simply renamed (no row added).

Override the default with --recover (always prepend the old name) or --rename-only
(never prepend; just rename). The result is written to a temp file and atomically
moved into place (or to --output).

Usage:
    quarry columns name <file> <column_name> [-o OUT]
    quarry columns name DamarJati.SD-Prompts.parquet prompt
    quarry columns name prompts.jsonl text
"""

_NAME_FORMATS = ("parquet", "csv", "jsonl")


def cmd_name(args) -> int:
    import duckdb

    path = Path(args.file)
    if not path.is_file():
        raise SystemExit(f"error: no such file: {path}")

    new_name = args.column.strip()
    if not new_name:
        raise SystemExit("error: column name is empty")

    fmt = detect_format(
        path, args.format, ext_map=EXT_FORMAT, formats=_NAME_FORMATS,
        hint="parquet|csv|jsonl",
    )
    dest = Path(args.output) if args.output else path
    reader = read_relation_sql(fmt, quote_literal(str(path)))

    con = duckdb.connect()
    try:
        described = con.execute(f"DESCRIBE SELECT * FROM {reader}").fetchall()
        existing = [r[0] for r in described]
        if len(existing) != 1:
            raise SystemExit(
                f"error: expected a single column, but {path.name} has "
                f"{len(existing)}: {', '.join(existing)}\n"
                "this tool only fixes single-column files with a missing header"
            )
        old_name = existing[0]

        if args.recover:
            recover = True
        elif args.rename_only:
            recover = False
        else:
            # parquet/csv absorb the first value into the name; jsonl does not.
            recover = fmt != "jsonl"

        old_ident = quote_ident(old_name)
        new_ident = quote_ident(new_name)
        if recover:
            select_sql = (
                f"SELECT {quote_literal(old_name)} AS {new_ident} "
                f"UNION ALL "
                f"SELECT {old_ident} AS {new_ident} FROM {reader}"
            )
        else:
            select_sql = f"SELECT {old_ident} AS {new_ident} FROM {reader}"

        with atomic_output(dest) as tmp_path:
            result = con.execute(
                f"COPY ({select_sql}) TO {quote_literal(str(tmp_path))} "
                f"({copy_options(fmt)})"
            ).fetchone()
    finally:
        con.close()

    total = result[0] if result else None
    action = (
        f"recovered orphaned value as the first row, renamed column -> {new_name!r}"
        if recover
        else f"renamed column {old_name!r} -> {new_name!r}"
    )
    print(f"{path} [{fmt}]: {action}\nWrote {total} row(s) to {dest}")
    return 0


# ===========================================================================
# columns reduce-json
# ===========================================================================

_REDUCE_DESC = """\
Reduce JSON-valued columns to a nested value in Parquet/CSV/JSONL file(s).

Some datasets carry whole JSON documents in a column -- either as a native
struct/list or as a raw JSON string. This command replaces such a column in place
with a single nested value pulled out of it, leaving every other column (and the
column order) untouched.

Extractions are given as a semicolon-separated list of column=path pairs, where
'path' is a dot-separated walk into the JSON. Integer segments index into
arrays/lists; everything else is an object key:

    conversations=0.value;meta=prompt

Each column is matched case-insensitively. Native columns are read as JSON via
to_json; VARCHAR/JSON columns are parsed as JSON text. Scalars come out clean and
unquoted; if a path points at a nested object/array, its JSON text is kept.
Before writing, the path is probed against the first rows and a path that matches
nothing is reported and skipped -- so re-running with a stale path won't silently
null a column.

The 'file' argument may be a single path or a shell-style wildcard pattern (*, ?,
[...], **). Files are processed concurrently (16 at a time by default, see -w) and
independently: a failure on one is reported and the rest still run.

Quote the mapping so the shell passes the ';' through:

    quarry columns reduce-json data.parquet 'conversations=0.value;meta=prompt'
    quarry columns reduce-json '000*.parquet' 'meta=prompt'
    quarry columns reduce-json 'shards/*.jsonl' 'conversations=0.value' --format jsonl
"""

# How many leading rows to probe when checking that a path matches anything.
_PROBE_ROWS = 200


def _path_to_pointer(path: str) -> str:
    """Convert a dot-path ('0.value', 'prompt') to a JSON Pointer ('/0/value')."""
    segments = path.split(".")
    if any(seg == "" for seg in segments):
        raise SystemExit(
            f"error: bad path {path!r}: empty segment (check for stray dots)"
        )
    escaped = [seg.replace("~", "~0").replace("/", "~1") for seg in segments]
    return "/" + "/".join(escaped)


def _extract_expr(col_ident: str, col_type: str, pointer: str) -> str:
    """SQL pulling ``pointer`` out of column ``col_ident`` as VARCHAR."""
    source = (
        col_ident
        if col_type.upper() in ("VARCHAR", "JSON")
        else f"to_json({col_ident})"
    )
    ptr = quote_literal(pointer)
    return (
        f"coalesce(json_extract_string({source}, {ptr}), "
        f"CAST(json_extract({source}, {ptr}) AS VARCHAR))"
    )


def _reduce_file(path, extractions, fmt_override):
    import duckdb

    fmt = detect_format(
        path, fmt_override, ext_map=EXT_FORMAT, formats=("parquet", "csv", "jsonl"),
        batch=True, hint="parquet|csv|jsonl",
    )

    con = duckdb.connect()
    try:
        described = con.execute(
            f"DESCRIBE SELECT * FROM {read_relation_sql(fmt)}", [str(path)]
        ).fetchall()
        existing = [(row[0], row[1]) for row in described]
        existing_lower = {name.lower() for name, _ in existing}

        target_path = {col.lower(): path_str for col, path_str in extractions}
        missing = [col for col, _ in extractions if col.lower() not in existing_lower]
        if missing:
            available = ", ".join(name for name, _ in existing)
            raise FileError(
                f"column(s) not found: {', '.join(missing)} (available: {available})"
            )

        reader = read_relation_sql(fmt, quote_literal(str(path)))

        select_parts: list[str] = []
        applied: list[tuple[str, str]] = []
        for name, col_type in existing:
            path_str = target_path.get(name.lower())
            if path_str is None:
                select_parts.append(quote_ident(name))
                continue
            ident = quote_ident(name)
            expr = _extract_expr(ident, col_type, _path_to_pointer(path_str))
            src_n, out_n = con.execute(
                f"SELECT count(*) FILTER (WHERE {ident} IS NOT NULL), count({expr}) "
                f"FROM (SELECT * FROM {reader} LIMIT {_PROBE_ROWS}) t"
            ).fetchone()
            if src_n and not out_n:
                raise FileError(
                    f"path {path_str!r} matched no values in column {name!r} "
                    f"(checked first {_PROBE_ROWS} rows); is the path correct?"
                )
            select_parts.append(f"{expr} AS {ident}")
            applied.append((name, path_str))

        select_list = ", ".join(select_parts)
        with atomic_output(path) as tmp_path:
            con.execute(
                f"COPY (SELECT {select_list} FROM {reader}) "
                f"TO {quote_literal(str(tmp_path))} ({copy_options(fmt)})"
            )
    finally:
        con.close()

    return fmt, applied


def cmd_reduce_json(args) -> int:
    extractions = parse_extractions(args.extractions)
    if not extractions:
        raise SystemExit("error: no extractions given")

    files = resolve_files(args.file)

    ok = 0
    failures: list[tuple[Path, str]] = []
    for path, result, exc in as_pool_results(
        lambda p: _reduce_file(p, extractions, args.format), files, args.workers
    ):
        if exc is not None:
            failures.append((path, str(exc)))
            print(f"  SKIP {path}: {exc}", file=sys.stderr)
            continue
        fmt, applied = result
        ok += 1
        mapping = ", ".join(f"{col} <- {p}" for col, p in applied)
        print(f"  {path} [{fmt}]: reduced {mapping}")

    if len(files) > 1 or failures:
        pairs = "; ".join(f"{col}={p}" for col, p in extractions)
        summary = f"Done: {ok}/{len(files)} file(s) reduced, extractions: {pairs}"
        if failures:
            summary += f"; {len(failures)} skipped"
        print(summary, file=sys.stderr)

    return 1 if failures else 0


# ===========================================================================
# registration
# ===========================================================================


def register(subparsers) -> None:
    raw = argparse.RawDescriptionHelpFormatter

    p = subparsers.add_parser(
        "show", help="print a file's column names as one comma-delimited line",
        description=_SHOW_DESC, formatter_class=raw,
        parents=[format_parent(_SHOW_FORMATS)],
    )
    p.add_argument("file", help="path to the data file")
    p.set_defaults(func=cmd_show)

    each_help = "override the format instead of inferring it from each extension"
    workers = workers_parent(16, _BATCH_WORKERS_HELP)

    p = subparsers.add_parser(
        "rename", help="rename columns in place, preserving column order",
        description=_RENAME_DESC, formatter_class=raw,
        parents=[format_parent(_TABULAR_CHOICES, each_help), workers],
    )
    p.add_argument("file", help="a file path or quoted wildcard pattern")
    p.add_argument(
        "renames",
        help="semicolon-separated old=new pairs; a bare column name is shorthand "
        "for 'name=prompt'",
    )
    p.set_defaults(func=cmd_rename)

    p = subparsers.add_parser(
        "remove", help="remove column(s) from parquet/csv/jsonl file(s) in place",
        description=_REMOVE_DESC, formatter_class=raw,
        parents=[format_parent(_TABULAR_CHOICES, each_help), workers],
    )
    p.add_argument("file", help="a file path or quoted wildcard pattern")
    p.add_argument("columns", help="comma-separated column name(s) to remove")
    p.set_defaults(func=cmd_remove)

    p = subparsers.add_parser(
        "reorder", help="move named column(s) to the front, in place",
        description=_REORDER_DESC, formatter_class=raw,
        parents=[format_parent(_REORDER_CHOICES, each_help), workers],
    )
    p.add_argument("file", help="a file path or quoted wildcard pattern")
    p.add_argument(
        "columns", help="comma-separated column name(s) to move to the front, in order"
    )
    p.set_defaults(func=cmd_reorder)

    p = subparsers.add_parser(
        "name", help="name the single column of a header-less file",
        description=_NAME_DESC, formatter_class=raw,
        parents=[format_parent(_NAME_FORMATS)],
    )
    p.add_argument("file", help="the single-column file to fix")
    p.add_argument("column", help="the name to give the column, e.g. 'prompt'")
    p.add_argument(
        "-o", "--output", default=None,
        help="write the result here instead of overwriting the file in place",
    )
    recovery = p.add_mutually_exclusive_group()
    recovery.add_argument(
        "--recover", action="store_true",
        help="always prepend the current column name back as the first row",
    )
    recovery.add_argument(
        "--rename-only", action="store_true",
        help="never prepend; just rename the existing column",
    )
    p.set_defaults(func=cmd_name)

    p = subparsers.add_parser(
        "reduce-json", help="reduce JSON-valued column(s) to a nested value in place",
        description=_REDUCE_DESC, formatter_class=raw,
        parents=[format_parent(_TABULAR_CHOICES, each_help), workers],
    )
    p.add_argument("file", help="a file path or quoted wildcard pattern")
    p.add_argument(
        "extractions",
        help="semicolon-separated column=path pairs, e.g. "
        "'conversations=0.value;meta=prompt'",
    )
    p.set_defaults(func=cmd_reduce_json)
