"""Complete structured-prompt identity and emptiness, shared by prep and cleanup."""
from __future__ import annotations

import datetime
import decimal
import json
import struct

from .common import FileError
from .lance import is_list_type, is_text_type, normalize_prompt


def prompt_key(value, dtype):
    """Return (has_content, canonical_key), with None exempting punctuation-only rows.

    Keys compare logical Arrow values: schema-unified missing/null fields coincide,
    while record order, empty/null slots, field identities and scalar types remain.
    """
    import pyarrow as pa

    def visit(item, kind):
        if item is None:
            return ["null"], False, False
        if is_list_type(kind):
            children = [visit(child, kind.value_type) for child in item]
            return ["list", [child[0] for child in children]], any(c[1] for c in children), any(c[2] for c in children)
        if pa.types.is_struct(kind):
            children = [(field.name, visit(item.get(field.name), field.type)) for field in kind]
            return ["object", [[name, child[0]] for name, child in children]], any(c[1] for _, c in children), any(c[2] for _, c in children)
        if is_text_type(kind):
            normalized = normalize_prompt(item)
            return ["text", normalized], bool(item.strip(" ")), bool(normalized)
        if isinstance(item, bool):
            encoded = ["bool", item]
        elif isinstance(item, int):
            encoded = ["int", str(item)]
        elif isinstance(item, float):
            encoded = ["float", struct.pack(">d", item).hex()]
        elif isinstance(item, bytes):
            encoded = ["binary", item.hex()]
        elif isinstance(item, decimal.Decimal):
            encoded = ["decimal", str(item)]
        elif isinstance(item, (datetime.datetime, datetime.date, datetime.time)):
            encoded = ["temporal", item.isoformat()]
        elif isinstance(item, datetime.timedelta):
            encoded = ["duration", item.days, item.seconds, item.microseconds]
        else:
            raise FileError(f"unsupported structured prompt scalar type: {kind}")
        return encoded, True, True

    encoded, nonempty, comparable = visit(value, dtype)
    if not nonempty or not comparable:
        return nonempty, None
    # Full-key grouping verifies equality; no application-level digest collisions.
    return True, json.dumps(
        ["quarry-structured-prompt-v1", str(dtype), encoded],
        ensure_ascii=False, separators=(",", ":"),
    ).encode("utf-8")


def clean_lance_records(ds, column, path, *, dedup=True, dry_run=False, batch_rows=4096):
    """Plan empty/duplicate rowid removal on disk, then delete in bounded batches.

    This operates on unencoded datasets through the explicit cleanup command;
    descriptor-backed storage is rebuilt through prep instead.
    """
    import tempfile
    import duckdb
    import pyarrow as pa

    dtype = ds.schema.field(column).type
    schema = pa.schema([
        ("ordinal", pa.int64()), ("rowid", pa.uint64()),
        ("nonempty", pa.bool_()), ("dedupkey", pa.binary()),
    ])

    def batches():
        ordinal = 0
        for batch in ds.scanner(columns=[column], with_row_id=True,
                                scan_in_order=True, batch_size=batch_rows).to_batches():
            keys = [prompt_key(value, dtype) for value in batch.column(column).to_pylist()]
            yield pa.RecordBatch.from_arrays([
                pa.array(range(ordinal, ordinal + batch.num_rows), type=pa.int64()),
                batch.column("_rowid"),
                pa.array([nonempty for nonempty, _ in keys], type=pa.bool_()),
                pa.array([key for _, key in keys], type=pa.binary()),
            ], schema=schema)
            ordinal += batch.num_rows

    with tempfile.TemporaryDirectory(dir=path.parent, prefix=".quarry-clean-") as work:
        con = duckdb.connect(work + "/clean.duckdb", config={
            "memory_limit": "256MB", "threads": 1,
            "preserve_insertion_order": False, "temp_directory": work + "/spill",
        })
        try:
            con.register("source_rows", pa.RecordBatchReader.from_batches(schema, batches()))
            con.execute("CREATE TABLE entries AS SELECT * FROM source_rows")
            con.execute("CREATE TABLE removed AS SELECT rowid, true AS empty FROM entries WHERE NOT nonempty")
            if dedup:
                con.execute(
                    "INSERT INTO removed SELECT rowid, false FROM entries "
                    "WHERE nonempty AND dedupkey IS NOT NULL AND ordinal NOT IN "
                    "(SELECT min(ordinal) FROM entries WHERE nonempty AND dedupkey IS NOT NULL GROUP BY dedupkey)"
                )
            empty, duplicates = con.execute(
                "SELECT count(*) FILTER (WHERE empty), count(*) FILTER (WHERE NOT empty) FROM removed"
            ).fetchone()
            if not dry_run:
                for batch in con.execute("SELECT rowid FROM removed").to_arrow_reader(batch_rows):
                    ds.delete("_rowid IN (" + ",".join(str(rowid) for rowid in batch.column(0).to_pylist()) + ")")
            return empty, duplicates
        finally:
            con.close()
