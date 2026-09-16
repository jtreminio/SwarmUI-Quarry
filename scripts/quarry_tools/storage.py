"""Quarry storage v1: searchable lowercase text plus lossless UTF-8 casing patches."""
from __future__ import annotations

import hashlib
import json
import pickle
import re
from pathlib import Path

from .common import FileError

DESCRIPTOR = "quarry-storage.json"
CASE_SUFFIX = "__case"
DATA_STORAGE_VERSION = "2.2"
UPPER = re.compile(b"[A-Z]")


def case_patch(original, lower):
    if original is None:
        return None
    if original == lower:
        return b""
    raw = original.encode("utf-8")
    if lower is None or raw.lower() != lower.encode("utf-8"):
        return b"F" + raw
    positions = [match.start() for match in UPPER.finditer(raw)]
    sparse = bytearray(b"S")
    previous = 0
    for position in positions:
        gap = position - previous
        previous = position
        while gap >= 128:
            sparse.append((gap & 127) | 128)
            gap >>= 7
        sparse.append(gap)
    if len(sparse) <= 1 + (len(raw) + 7) // 8:
        return bytes(sparse)
    bitmap = bytearray(1 + (len(raw) + 7) // 8)
    bitmap[0] = ord("B")
    for position in positions:
        bitmap[1 + position // 8] |= 1 << (position % 8)
    return bytes(bitmap)


def restore_case(lower, patch):
    if patch is None:
        if lower is not None:
            raise FileError("null casing patch for non-null text")
        return None
    if lower is None:
        raise FileError("casing patch for null text")
    if not patch:
        return lower
    if patch[:1] == b"F":
        return patch[1:].decode("utf-8", errors="strict")
    raw = bytearray(lower.encode("utf-8"))

    def capitalize(position):
        if position >= len(raw) or not 97 <= raw[position] <= 122:
            raise FileError("invalid casing patch offset")
        raw[position] -= 32

    if patch[:1] == b"S":
        position = gap = shift = 0
        for byte in patch[1:]:
            if shift >= 35:
                raise FileError("casing patch varint overflow")
            gap |= (byte & 127) << shift
            if byte & 128:
                shift += 7
            else:
                position += gap
                capitalize(position)
                gap = shift = 0
        if shift or len(patch) == 1:
            raise FileError("truncated casing patch")
    elif patch[:1] == b"B":
        if len(patch) != 1 + (len(raw) + 7) // 8:
            raise FileError("invalid casing bitmap length")
        for i, byte in enumerate(patch[1:]):
            for bit in range(8):
                if byte & (1 << bit):
                    capitalize(i * 8 + bit)
    else:
        raise FileError("unknown casing patch format")
    return raw.decode("utf-8", errors="strict")


def read_descriptor(path, schema=None):
    file = Path(path) / DESCRIPTOR
    if not file.exists():
        return {}
    try:
        value = json.loads(file.read_text(encoding="utf-8"))
        pairs = value["columns"]
        if value["version"] != 1 or not isinstance(pairs, dict):
            raise ValueError("unsupported format")
        if any(not isinstance(k, str) or v != k + CASE_SUFFIX for k, v in pairs.items()):
            raise ValueError("invalid column mapping")
        if len({n.casefold() for n in [*pairs, *pairs.values()]}) != 2 * len(pairs):
            raise ValueError("ambiguous column mapping")
        if schema is not None:
            import pyarrow as pa
            for name, patch in pairs.items():
                if not is_text(schema.field(name).type) or not pa.types.is_binary(schema.field(patch).type):
                    raise ValueError("invalid column types")
        return pairs
    except (ValueError, KeyError, TypeError) as exc:
        raise FileError(f"invalid {file}: {exc}") from exc


def write_descriptor(path, pairs, *, optimized=None):
    import uuid

    value = {"version": 1, "columns": pairs}
    if optimized is not None:
        value["optimized"] = optimized
    descriptor = Path(path) / DESCRIPTOR
    temporary = Path(path) / f".{DESCRIPTOR}.{uuid.uuid4().hex}.tmp"
    with temporary.open("x", encoding="utf-8") as file:
        try:
            file.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
            file.close()
            if descriptor.exists():
                temporary.chmod(descriptor.stat().st_mode & 0o777)
            temporary.replace(descriptor)
        finally:
            temporary.unlink(missing_ok=True)


def is_text(dtype):
    import pyarrow as pa
    return pa.types.is_string(dtype) or pa.types.is_large_string(dtype)


def legacy_pairs(schema):
    pairs = {name[:-4]: name for name in schema.names
             if name.endswith("__lc") and name[:-4] in schema.names}
    if set(pairs) & set(pairs.values()):
        raise FileError("overlapping __lc companion pairs")
    for name, companion in pairs.items():
        if not is_text(schema.field(name).type) or not is_text(schema.field(companion).type):
            raise FileError(f"invalid legacy companion {companion!r}")
    return pairs


def logical_reader(ds, path, names=None, batch_rows=65536):
    """Expose original values; remove only recognized storage companions."""
    import pyarrow as pa
    pairs = read_descriptor(path, ds.schema)
    hidden = set(pairs.values()) | set(legacy_pairs(ds.schema).values())
    names = names if names is not None else [n for n in ds.schema.names if n not in hidden]
    fields = [ds.schema.field(n) for n in names]
    schema = pa.schema(fields, metadata=ds.schema.metadata)
    projection = list(dict.fromkeys(names + [pairs[n] for n in names if n in pairs]))

    def batches():
        for batch in ds.scanner(columns=projection, batch_size=batch_rows, scan_in_order=True).to_batches():
            arrays = []
            for name in names:
                array = batch.column(name)
                if name in pairs:
                    array = pa.array([restore_case(v, p) for v, p in zip(
                        array.to_pylist(), batch.column(pairs[name]).to_pylist())], type=schema.field(name).type)
                arrays.append(array)
            yield pa.RecordBatch.from_arrays(arrays, schema=schema)
    return pa.RecordBatchReader.from_batches(schema, batches())


class LogicalDigest:
    """Order-sensitive, batch-boundary-independent hashes of typed logical values."""
    def __init__(self, schema):
        self.schema = schema
        self.rows = 0
        self.hashes = [hashlib.sha256() for _ in schema]

    def update(self, batch):
        self.rows += batch.num_rows
        for array, digest in zip(batch.columns, self.hashes):
            for value in array.to_pylist():
                data = pickle.dumps(value, protocol=4)
                digest.update(len(data).to_bytes(8, "little"))
                digest.update(data)

    def result(self):
        return self.rows, [h.hexdigest() for h in self.hashes]


def encoded_reader(reader, digest=None, *, miniblock=True):
    """One streaming pass, using DuckDB's lowercase semantics for indexed search."""
    import duckdb
    import pyarrow as pa
    from .common import quote_ident

    names = reader.schema.names
    if len({n.casefold() for n in names}) != len(names):
        raise FileError("column names differ only by case")
    pairs = {f.name: f.name + CASE_SUFFIX for f in reader.schema if is_text(f.type)}
    folded = {n.casefold() for n in names}
    for patch in pairs.values():
        if patch.casefold() in folded:
            raise FileError(f"{patch!r} conflicts with a casing companion")
    fields = []
    for field in reader.schema:
        metadata = {k: v for k, v in (field.metadata or {}).items() if not k.startswith(b"lance-encoding:")}
        if miniblock and field.name in pairs:
            metadata[b"lance-encoding:structural-encoding"] = b"miniblock"
        fields.append(field.with_metadata(metadata or None))
    schema = pa.schema(fields + [pa.field(p, pa.binary()) for p in pairs.values()], metadata=reader.schema.metadata)

    def batches():
        con = duckdb.connect()
        try:
            for batch in reader:
                if digest is not None:
                    digest.update(batch)
                arrays = list(batch.columns)
                patches = []
                if pairs:
                    con.register("casing_batch", pa.Table.from_batches([batch]).select(list(pairs)))
                    lower = con.execute("SELECT " + ", ".join(
                        f"lower({quote_ident(n)}) AS {quote_ident(n)}" for n in pairs
                    ) + " FROM casing_batch").fetch_arrow_table()
                    for name in pairs:
                        index = names.index(name)
                        low = lower.column(name).cast(reader.schema.field(name).type).combine_chunks()
                        original = arrays[index].to_pylist()
                        patch = [case_patch(v, l) for v, l in zip(original, low.to_pylist())]
                        arrays[index] = low
                        patches.append(pa.array(patch, type=pa.binary()))
                yield pa.RecordBatch.from_arrays(arrays + patches, schema=schema)
        finally:
            con.close()
            reader.close()
    return pa.RecordBatchReader.from_batches(schema, batches()), pairs


def verify_dataset(path, expected):
    import lance
    ds = lance.dataset(str(path))
    reader = logical_reader(ds, path)
    if [(f.name, f.type) for f in reader.schema] != [(f.name, f.type) for f in expected.schema]:
        raise FileError("rewritten logical schema does not match source")
    actual = LogicalDigest(reader.schema)
    for batch in reader:
        actual.update(batch)
    if actual.result() != expected.result():
        raise FileError("rewritten dataset failed logical value verification")
