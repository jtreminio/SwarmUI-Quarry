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


class ColumnPairs(dict):
    """Flat mappings plus writer-only information for the structured layout."""
    def __init__(self, pairs, helpers=(), structured=False):
        super().__init__(pairs)
        self.helpers = list(helpers)
        self.structured = structured


def helper_layout(schema):
    import pyarrow as pa
    helpers = []
    structured = False
    names = {n.casefold() for n in schema.names}
    for column in schema:
        dtype = column.type
        kind = "object"
        if pa.types.is_list(dtype) or pa.types.is_large_list(dtype):
            dtype = dtype.value_type
            kind = "list"
        if not pa.types.is_struct(dtype):
            continue
        structured = True
        for field in dtype:
            if not is_text(field.type):
                continue
            physical = f"__quarry_search_{len(helpers)}"
            if physical.casefold() in names:
                raise FileError(f"{physical!r} conflicts with an internal search column; rename it")
            helpers.append(dict(column=column.name, field=field.name, kind=kind, physical=physical))
    return helpers, structured


def manifest_snapshot(path):
    manifests = list((Path(path) / "_versions").glob("*.manifest"))
    if len(manifests) != 1:
        return None
    manifest = manifests[0]
    return {"manifest": manifest.relative_to(path).as_posix(),
            "sha256": hashlib.sha256(manifest.read_bytes()).hexdigest()}


def read_layout(path, schema=None, *, trusted_staging=False):
    file = Path(path) / DESCRIPTOR
    if not file.exists():
        return {"version": 1, "columns": {}, "helpers": []}
    try:
        value = json.loads(file.read_text(encoding="utf-8"))
        pairs = value["columns"]
        if value["version"] not in (1, 2) or not isinstance(pairs, dict):
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
        helpers = value.get("helpers", []) if value["version"] == 2 else []
        if not isinstance(helpers, list):
            raise ValueError("invalid search helper mapping")
        occupied = {n.casefold() for n in [*pairs, *pairs.values()]}
        logical_sources = {h.get("column", "").casefold() for h in helpers if isinstance(h, dict)
                           and isinstance(h.get("column"), str)}
        paths = set()
        for helper in helpers:
            if not isinstance(helper, dict) or any(not isinstance(helper.get(k), str)
                    for k in ("column", "field", "kind", "physical")):
                raise ValueError("invalid search helper")
            identity = (helper["column"].casefold(), helper["field"].casefold())
            if (not helper["column"].strip() or not helper["field"].strip()
                    or not helper["physical"].startswith("__quarry_search_")
                    or len(helper["physical"]) <= len("__quarry_search_")
                    or helper["kind"] not in ("object", "list") or identity in paths
                    or helper["physical"].casefold() in occupied | logical_sources):
                raise ValueError("ambiguous search helper mapping")
            paths.add(identity)
            occupied.add(helper["physical"].casefold())
            if schema is not None:
                dtype = schema.field(helper["column"]).type
                if helper["kind"] == "list":
                    if not (pa.types.is_list(dtype) or pa.types.is_large_list(dtype)):
                        raise ValueError("invalid helper source type")
                    dtype = dtype.value_type
                if not pa.types.is_struct(dtype) or not is_text(dtype.field(helper["field"]).type):
                    raise ValueError("invalid helper source field")
                if helper["physical"] in schema.names and not is_text(schema.field(helper["physical"]).type):
                    raise ValueError("invalid helper physical type")
        value["helpers"] = helpers
        if value["version"] == 2 and not trusted_staging:
            actual = manifest_snapshot(path)
            trusted = actual is not None and actual == value.get("snapshot")
            if pairs and not trusted:
                raise ValueError("dataset changed outside Quarry; casing storage cannot be verified; rebuild from original input")
            value["snapshot_trusted"] = trusted
        return value
    except (ValueError, KeyError, TypeError, IndexError) as exc:
        raise FileError(f"invalid {file}: {exc}") from exc


def read_descriptor(path, schema=None, *, trusted_staging=False):
    return read_layout(path, schema, trusted_staging=trusted_staging)["columns"]


def write_descriptor(path, pairs, *, optimized=None, helpers=None, finalize=False):
    import uuid

    descriptor = Path(path) / DESCRIPTOR
    value = json.loads(descriptor.read_text()) if descriptor.exists() else {}
    value.pop("datasetHash", None)
    value.pop("snapshot", None)
    value.pop("helpers_indexed", None)
    if helpers is None:
        helpers = getattr(pairs, "helpers", value.get("helpers", []))
    structured = getattr(pairs, "structured", False) or value.get("version") == 2 or bool(helpers)
    value.update(version=2 if structured else 1, columns=dict(pairs))
    if structured:
        value.update(search_version=1, helpers=helpers, data_storage_version=DATA_STORAGE_VERSION,
                     stable_row_ids=False)
        if finalize:
            import lance
            ds = lance.dataset(str(path))
            if ds.has_stable_row_ids:
                raise FileError("prepared datasets must use physical row IDs")
            required = set(pairs) | {h["physical"] for h in helpers}
            verify_index_coverage(ds, required)
            snapshot = manifest_snapshot(path)
            if snapshot is None:
                raise FileError("expected one finalized dataset manifest")
            value.update(snapshot=snapshot, helpers_indexed=True)
    if optimized is not None:
        value["optimized"] = optimized
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


def verify_index_coverage(ds, required):
    fragments = {f.fragment_id for f in ds.get_fragments()}
    covered = {ds.lance_schema.field(i["fields"][0]).name() for i in ds.list_indices()
               if i["type"] == "NGram" and len(i["fields"]) == 1
               and fragments <= set(i["fragment_ids"] or [])}
    if not set(required) <= covered:
        raise FileError(f"missing complete NGRAM indexes: {sorted(set(required) - covered)}")


def _search_arrays(batch, helpers):
    """Decode each record column once, then derive its field search values."""
    import pyarrow as pa

    sources = {name: batch.column(name).to_pylist()
               for name in dict.fromkeys(h["column"] for h in helpers)}
    arrays = []
    for helper in helpers:
        values = []
        for value in sources[helper["column"]]:
            records = value if helper["kind"] == "list" else [value]
            values.append("\x1f".join(record[helper["field"]] for record in records or []
                if record is not None and record.get(helper["field"]) is not None))
        arrays.append(pa.array(values, type=pa.string()))
    return arrays


def verify_helpers(path):
    """Verify derived text against authoritative nested records before publication."""
    import duckdb
    import lance
    import pyarrow as pa
    from .common import quote_ident
    ds = lance.dataset(str(path))
    layout = read_layout(path, ds.schema, trusted_staging=True)
    helpers = layout["helpers"]
    if not helpers:
        return
    names = list(dict.fromkeys([h["column"] for h in helpers] + [h["physical"] for h in helpers]))
    con = duckdb.connect()
    try:
        for batch in ds.scanner(columns=names, batch_size=1024, scan_in_order=True).to_batches():
            originals = _search_arrays(batch, helpers)
            con.register("originals", pa.Table.from_arrays(originals, names=[h["physical"] for h in helpers]))
            expected = con.execute("SELECT " + ", ".join(
                f"lower({quote_ident(h['physical'])}) AS {quote_ident(h['physical'])}" for h in helpers)
                + " FROM originals").fetch_arrow_table()
            for helper in helpers:
                name = helper["physical"]
                if batch.column(name).to_pylist() != expected.column(name).to_pylist():
                    raise FileError(f"search helper {name!r} does not match its source values")
    finally:
        con.close()


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


def logical_reader(ds, path, names=None, batch_rows=65536, *, trusted_staging=False, projections=None):
    """Expose original values; remove only recognized storage companions."""
    import pyarrow as pa
    layout = read_layout(path, ds.schema, trusted_staging=trusted_staging)
    pairs = layout["columns"]
    hidden = set(pairs.values()) | set(legacy_pairs(ds.schema).values()) | {h["physical"] for h in layout["helpers"]}
    if names is not None and hidden.intersection(names):
        raise FileError("internal storage columns cannot be selected")
    names = names if names is not None else [n for n in ds.schema.names if n not in hidden]
    projection = list(dict.fromkeys(names + [pairs[n] for n in names if n in pairs]))
    if projections:
        if set(projections) - set(names) or set(projections).intersection(pairs):
            raise FileError("projections must select unencoded logical columns")
        projection = {n: projections.get(n, "`" + n.replace("`", "``") + "`") for n in projection}
    scanner = ds.scanner(columns=projection, batch_size=batch_rows, scan_in_order=True) if projections else None
    fields = [scanner.projected_schema.field(n) if projections and n in projections
              else ds.schema.field(n) for n in names]
    schema = pa.schema(fields, metadata=ds.schema.metadata)

    def batches():
        source = scanner if scanner is not None else ds.scanner(
            columns=projection, batch_size=batch_rows, scan_in_order=True)
        for batch in source.to_batches():
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
    helpers, structured = helper_layout(reader.schema)
    pairs = ColumnPairs({f.name: f.name + CASE_SUFFIX for f in reader.schema if is_text(f.type)},
                        helpers, structured)
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
    helper_fields = [pa.field(h["physical"], pa.string(), metadata=(
        {b"lance-encoding:structural-encoding": b"miniblock"} if miniblock else None)) for h in helpers]
    schema = pa.schema(fields + [pa.field(p, pa.binary()) for p in pairs.values()] + helper_fields,
                       metadata=reader.schema.metadata)

    def batches():
        con = duckdb.connect()
        try:
            for batch in reader:
                if digest is not None:
                    digest.update(batch)
                arrays = list(batch.columns)
                patches = []
                helper_arrays = _search_arrays(batch, helpers)
                search_names = list(pairs) + [h["physical"] for h in helpers]
                if search_names:
                    con.register("casing_batch", pa.Table.from_arrays(
                        [batch.column(name) for name in pairs] + helper_arrays, names=search_names))
                    lower = con.execute("SELECT " + ", ".join(
                        f"lower({quote_ident(n)}) AS {quote_ident(n)}" for n in search_names
                    ) + " FROM casing_batch").fetch_arrow_table()
                    for name in pairs:
                        index = names.index(name)
                        low = lower.column(name).cast(reader.schema.field(name).type).combine_chunks()
                        original = arrays[index].to_pylist()
                        patch = [case_patch(v, l) for v, l in zip(original, low.to_pylist())]
                        arrays[index] = low
                        patches.append(pa.array(patch, type=pa.binary()))
                    helper_arrays = [lower.column(h["physical"]).combine_chunks() for h in helpers]
                yield pa.RecordBatch.from_arrays(arrays + patches + helper_arrays, schema=schema)
        finally:
            con.close()
            reader.close()
    return pa.RecordBatchReader.from_batches(schema, batches()), pairs


def verify_dataset(path, expected, *, trusted_staging=False):
    import lance
    ds = lance.dataset(str(path))
    reader = logical_reader(ds, path, trusted_staging=trusted_staging)
    if [(f.name, f.type) for f in reader.schema] != [(f.name, f.type) for f in expected.schema]:
        raise FileError("rewritten logical schema does not match source")
    actual = LogicalDigest(reader.schema)
    for batch in reader:
        actual.update(batch)
    if actual.result() != expected.result():
        raise FileError("rewritten dataset failed logical value verification")
    verify_duckdb(path, expected, trusted_staging=trusted_staging)


def verify_duckdb(path, expected, *, trusted_staging=False):
    """Force the runtime reader to materialize every logical value before publish."""
    import duckdb
    import pyarrow as pa
    from .common import quote_ident, quote_literal
    layout = read_layout(path, trusted_staging=trusted_staging)
    pairs = layout["columns"]
    names = expected.schema.names
    projection = list(dict.fromkeys(names + [pairs[n] for n in names if n in pairs]))
    actual = LogicalDigest(expected.schema)
    con = duckdb.connect()
    try:
        try:
            con.execute("LOAD lance")
        except duckdb.IOException as exc:
            if 'Install it first using "INSTALL lance"' not in str(exc):
                raise
            con.execute("INSTALL lance")
            con.execute("LOAD lance")
        con.execute("SET threads=2")
        con.execute("SET memory_limit='1GB'")
        reader = con.execute("SELECT " + ", ".join(quote_ident(n) for n in projection)
            + " FROM " + quote_literal(str(path)) + ' ORDER BY "_rowid"').fetch_record_batch(1024)
        for batch in reader:
            arrays = []
            for field in expected.schema:
                array = batch.column(field.name)
                if field.name in pairs:
                    array = pa.array([restore_case(v, p) for v, p in zip(
                        array.to_pylist(), batch.column(pairs[field.name]).to_pylist())], type=field.type)
                elif array.type != field.type:
                    array = array.cast(field.type)
                arrays.append(array)
            actual.update(pa.RecordBatch.from_arrays(arrays, schema=expected.schema))
        if actual.result() != expected.result():
            raise FileError("DuckDB reader failed logical value verification")
    except Exception as exc:
        if isinstance(exc, FileError):
            raise
        raise FileError(f"DuckDB could not verify the prepared dataset: {exc}") from exc
    finally:
        con.close()
