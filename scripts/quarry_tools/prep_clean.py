"""Disk-backed cleaning before the interactive prep command writes Lance."""

from __future__ import annotations

import os
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from .common import quote_ident
from .lance import is_record_type, is_text_type, normalize_prompt
from .structured import prompt_key


@contextmanager
def progress(label, emit):
    """Keep long native operations visible even between Arrow batches."""
    started = time.monotonic()
    stopped = threading.Event()
    emit(f"{label}…")

    def report():
        while not stopped.wait(10):
            emit(f"  {label}: {time.monotonic() - started:.0f}s elapsed")

    thread = threading.Thread(target=report, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stopped.set()
        thread.join()


def _internal_name(names, base):
    existing = {name.lower() for name in names}
    while base.lower() in existing:
        base += "_"
    return base


@contextmanager
def cleaned_reader(reader, prompt_column, work: Path, *, batch_rows=50_000,
                   memory_limit="32GB", emit=print):
    """Keep first normalized prompts, preserving source order and Arrow types.

    DuckDB stores rows and deduplication keys on disk and spills aggregation and
    sorting when necessary. ASCII keys use native expressions; non-ASCII keys
    retain Python's exact Unicode lower()/isalnum() behavior. Punctuation-only
    prompts remain distinct, matching the existing Lance cleanup semantics.
    """
    import duckdb
    import pyarrow as pa

    schema = reader.schema
    order_name = _internal_name(schema.names, "__quarry_order")
    order = quote_ident(order_name)
    key_name = _internal_name(schema.names, "__quarry_key")
    key = quote_ident(key_name)
    nonempty_name = _internal_name(schema.names, "__quarry_nonempty")
    prompt = quote_ident(prompt_column)
    prompt_type = schema.field(prompt_column).type
    text_prompt = is_text_type(prompt_type)
    record_prompt = is_record_type(prompt_type)
    source_rows = 0
    # Keep all work on the output filesystem, not in RAM or the system /tmp.
    con = duckdb.connect(str(work / "clean.duckdb"), config={
        "memory_limit": memory_limit,
        # Explicit ordinals and the final ORDER BY define output order, so
        # intermediate operators do not need to buffer rows to preserve it.
        "preserve_insertion_order": False,
        "temp_directory": str(work / "spill"),
    })
    try:
        # Each parallel sort/join worker needs buffers even when spilling.
        # DuckDB returns its validated limit in canonical binary units.
        amount, unit = con.execute("SELECT current_setting('memory_limit')").fetchone()[0].split()
        units = {name: 1024 ** i for i, name in enumerate(("bytes", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"))}
        memory_bytes = float(amount) * units[unit]
        workers = max(1, min(8, os.cpu_count() or 1, int(memory_bytes / (512 * 1024 ** 2))))
        con.execute(f"SET threads = {workers}")

        def numbered_batches():
            nonlocal source_rows
            offset = 0
            for batch in reader:
                # Assign order before DuckDB's parallel scan. A SQL row_number()
                # window here would serialize the normalization pipeline.
                positions = pa.array(range(offset, offset + batch.num_rows), type=pa.int64())
                numbered = batch.append_column(order_name, positions)
                if record_prompt:
                    keys = [prompt_key(value, prompt_type) for value in batch.column(prompt_column).to_pylist()]
                    numbered = numbered.append_column(key_name, pa.array([key for _, key in keys], type=pa.binary()))
                    numbered = numbered.append_column(nonempty_name, pa.array([nonempty for nonempty, _ in keys], type=pa.bool_()))
                offset += batch.num_rows
                source_rows = offset
                yield numbered

        numbered_schema = schema.append(pa.field(order_name, pa.int64()))
        if record_prompt:
            numbered_schema = numbered_schema.append(pa.field(key_name, pa.binary())).append(pa.field(nonempty_name, pa.bool_()))
        numbered = pa.RecordBatchReader.from_batches(numbered_schema, numbered_batches())
        con.register("source_rows", numbered)
        if text_prompt:
            con.create_function("normalize_unicode", normalize_prompt, ["VARCHAR"], "VARCHAR")
            normalized = (
                f"CASE WHEN length({prompt}) = strlen({prompt}) "
                f"THEN translate(lower({prompt}), ?, '') "
                f"ELSE normalize_unicode({prompt}) END"
            )
            parameters = ["".join(chr(i) for i in range(128) if not chr(i).isalnum())]
            # Lance trim() removes ASCII spaces, not all Unicode whitespace.
            nonempty = f"{prompt} IS NOT NULL AND length(trim({prompt}, ' ')) > 0"
        elif record_prompt:
            normalized = None
            nonempty = quote_ident(nonempty_name)
            parameters = []
        else:
            normalized = "NULL::VARCHAR"
            nonempty = f"{prompt} IS NOT NULL"
            parameters = []

        with progress("Reading selected columns and removing empty prompts", emit):
            projection = (
                f"* EXCLUDE ({quote_ident(nonempty_name)})" if record_prompt
                else f"*, {normalized} AS {key}"
            )
            con.execute(
                f"CREATE TABLE input_rows AS SELECT {projection} FROM source_rows WHERE {nonempty}", parameters,
            )
        nonempty_rows = con.execute("SELECT count(*) FROM input_rows").fetchone()[0]
        emit(f"  Removed {source_rows - nonempty_rows:,} empty prompt row(s); {nonempty_rows:,} nonempty row(s)")
        columns = ", ".join(quote_ident(name) for name in schema.names)
        if text_prompt or record_prompt:
            comparable = f"{key} IS NOT NULL" if record_prompt else f"{key} <> ''"
            exempt = f"{key} IS NULL" if record_prompt else f"{key} = ''"
            with progress("Finding first occurrences of normalized prompts", emit):
                con.execute(
                    f"CREATE TABLE kept_rows AS "
                    f"SELECT min({order}) AS {order} FROM input_rows WHERE {comparable} GROUP BY {key} "
                    f"UNION ALL SELECT {order} FROM input_rows WHERE {exempt}"
                )
            retained = con.execute("SELECT count(*) FROM kept_rows").fetchone()[0]
            emit(f"  Removed {nonempty_rows - retained:,} duplicate row(s); keeping {retained:,}")
            query = (
                f"SELECT {columns} FROM input_rows SEMI JOIN kept_rows USING ({order}) "
                f"ORDER BY {order}"
            )
        else:
            query = f"SELECT {columns} FROM input_rows ORDER BY {order}"

        # DuckDB may widen some Arrow types. Cast back so selected columns keep
        # the same types and order as the original conversion pipeline.
        with progress("Writing cleaned rows to Lance in source order", emit):
            batches = con.execute(query).to_arrow_reader(batch_rows)

            def restored_batches():
                for batch in batches:
                    yield batch.cast(schema)

            yield pa.RecordBatchReader.from_batches(schema, restored_batches())
    finally:
        con.close()
