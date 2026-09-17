"""Lossless JSON schema discovery before Arrow/DuckDB can coerce source kinds."""
from __future__ import annotations

from contextlib import contextmanager
import json
import math
from pathlib import Path

from .common import FileError, quote_ident, quote_literal

EMPTY_STRUCTURE = b"quarry:empty-structure"
_MIN_I64, _MAX_I64, _MAX_U64 = -(2**63), 2**63 - 1, 2**64 - 1


def _object(pairs):
    result = {}
    folded = set()
    for key, value in pairs:
        if key.lower() in folded:
            raise FileError(f"JSON field {key!r} is duplicated or differs only by case")
        folded.add(key.lower())
        result[key] = value
    return result


def _invalid_constant(value):
    raise FileError(f"non-finite JSON number {value!r} is not supported")


def rows(path: Path, fmt: str):
    """Stream JSONL or a JSON array, buffering at most one document/record."""
    decoder = json.JSONDecoder(object_pairs_hook=_object, parse_constant=_invalid_constant)
    with path.open(encoding="utf-8-sig") as source:
        if fmt == "jsonl":
            for line_number, line in enumerate(source, 1):
                if not line.strip():
                    continue
                try:
                    row = decoder.decode(line)
                except (ValueError, FileError) as exc:
                    raise FileError(f"{path}:{line_number}: {exc}") from exc
                if not isinstance(row, dict):
                    raise FileError(f"{path}:{line_number}: expected a JSON object")
                yield row
            return

        buffer, ended = "", False

        def fill():
            nonlocal buffer, ended
            part = source.read(65536)
            buffer += part
            ended = not part

        def whitespace():
            nonlocal buffer
            while True:
                buffer = buffer.lstrip()
                if buffer or ended:
                    return
                fill()

        def record():
            nonlocal buffer
            while True:
                try:
                    row, consumed = decoder.raw_decode(buffer)
                    buffer = buffer[consumed:]
                    if not isinstance(row, dict):
                        raise FileError(f"{path}: expected a JSON object")
                    return row
                except json.JSONDecodeError as exc:
                    if ended:
                        raise FileError(f"{path}: invalid JSON: {exc}") from exc
                    fill()

        whitespace()
        if buffer.startswith("["):
            buffer = buffer[1:]
            whitespace()
            if buffer.startswith("]"):
                buffer = buffer[1:]
            else:
                while True:
                    yield record()
                    whitespace()
                    if buffer.startswith("]"):
                        buffer = buffer[1:]
                        break
                    if not buffer.startswith(","):
                        raise FileError(f"{path}: expected ',' or ']' after JSON record")
                    buffer = buffer[1:]
                    whitespace()
        elif buffer:
            yield record()
        else:
            raise FileError(f"{path}: empty JSON document")
        whitespace()
        if buffer:
            raise FileError(f"{path}: unexpected content after JSON document")


class _Node:
    def __init__(self):
        self.kind = None
        self.fields = {}
        self.folded = {}
        self.element = None
        self.low = self.high = 0

    def add(self, value, path, *, depth=0):
        if value is None:
            return
        kind = {str: "text", bool: "boolean", int: "integer", float: "float", dict: "object", list: "list"}[type(value)]
        if depth >= 1 and kind in ("object", "list"):
            raise FileError(f"{path}: records must contain direct scalar fields; nested objects/arrays are not supported")
        if self.kind is not None and kind != self.kind:
            raise FileError(f"{path}: incompatible scalar/value types {self.kind} and {kind}; use one type per field")
        self.kind = kind
        if kind == "integer":
            self.low, self.high = min(self.low, value), max(self.high, value)
            if self.low < _MIN_I64 or self.high > _MAX_U64 or (self.low < 0 and self.high > _MAX_I64):
                raise FileError(f"{path}: integer values cannot fit one signed or unsigned 64-bit field")
        elif kind == "float" and not math.isfinite(value):
            raise FileError(f"{path}: non-finite numbers are not supported")
        elif kind == "object":
            for key, item in value.items():
                if key.lower() in self.folded and self.folded[key.lower()] != key:
                    raise FileError(f"{path}.{key}: field names differ only by case")
                self.folded[key.lower()] = key
                self.fields.setdefault(key, _Node()).add(item, f"{path}.{key}", depth=depth + 1)
        elif kind == "list":
            if self.element is None:
                self.element = _Node()
            for item in value:
                if isinstance(item, list):
                    raise FileError(f"{path}[]: arrays of arrays are not supported")
                # Top-level scalar lists retain their established flattening path.
                self.element.add(item, path + "[]", depth=depth)

    def empty_structure(self):
        return self.kind == "object" and not self.fields or self.kind == "list" and (
            self.element is not None and self.element.empty_structure()
        )

    def sql(self):
        if self.kind in (None, "text") or self.empty_structure():
            return "VARCHAR"
        if self.kind == "boolean":
            return "BOOLEAN"
        if self.kind == "integer":
            return "UBIGINT" if self.high > _MAX_I64 else "BIGINT"
        if self.kind == "float":
            return "DOUBLE"
        if self.kind == "object":
            return "STRUCT(" + ", ".join(quote_ident(key) + " " + value.sql() for key, value in self.fields.items()) + ")"
        return self.element.sql() + "[]"


def discover(path: Path, fmt: str):
    root, count = _Node(), 0
    for row in rows(path, fmt):
        root.add(row, "$", depth=-1)
        count += 1
    return root, count


def validate_empty_selections(schema, selected, prompt_column):
    """Uninferable prompt structures are empty; other selected structures need a schema."""
    for source, target in selected:
        if EMPTY_STRUCTURE in (schema.field(source).metadata or {}) and target != prompt_column:
            raise FileError(f"column {source!r} contains only empty structures; omit it or supply an object field schema")


@contextmanager
def open_json_source(path: Path, fmt: str, batch_rows: int):
    import duckdb
    import pyarrow as pa

    root, count = discover(path, fmt)
    if not root.fields:
        schema = pa.schema([])
        yield schema, count, lambda names: pa.RecordBatchReader.from_batches(schema, [])
        return
    columns = ", ".join(quote_literal(name) + ": " + quote_literal(node.sql()) for name, node in root.fields.items())
    format_option = ", format='newline_delimited'" if fmt == "jsonl" else ""
    sql = f"read_json({quote_literal(str(path))}, columns={{{columns}}}, map_inference_threshold=-1{format_option})"
    con = duckdb.connect()
    try:
        relation = con.sql(f"SELECT * FROM {sql}")
        schema = relation.limit(0).to_arrow_reader(batch_rows).schema
        placeholders = {name for name, node in root.fields.items() if node.empty_structure()}
        schema = pa.schema([
            field.with_metadata({EMPTY_STRUCTURE: b"true"}) if field.name in placeholders else field
            for field in schema
        ])

        def batches(names):
            output_schema = pa.schema([schema.field(name) for name in names])
            projection = ", ".join(
                f"NULL::VARCHAR AS {quote_ident(name)}" if name in placeholders else quote_ident(name)
                for name in names
            )
            source = relation.project(projection).to_arrow_reader(batch_rows)
            def converted():
                for batch in source:
                    yield pa.RecordBatch.from_arrays(batch.columns, schema=output_schema)
            return pa.RecordBatchReader.from_batches(output_schema, converted())

        yield schema, count, batches
    finally:
        con.close()
