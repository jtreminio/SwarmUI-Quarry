#!/usr/bin/env python3
"""Reproducible, isolated Lance storage experiments; never modify the source.

Run with the repository's .venv/bin/python. Outputs live under the supplied
workspace directory, including independent datasets, raw timings, and a report.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import timedelta
import hashlib
import itertools
import json
import os
from pathlib import Path
import random
import re
import shutil
import statistics
import subprocess
import sys
import time

UPPER = re.compile(b"[A-Z]")
CASE_SUFFIX = "__case"
SELECTED = {"prompt", "tags", "character", "copyright"}


def write_json(path, value):
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(value, indent=2, default=str) + "\n")
    temporary.replace(path)


def log(message):
    print(time.strftime("%H:%M:%S"), message, flush=True)


def case_patch(original, lower, codec="adaptive"):
    """ASCII-capital byte offsets; Unicode changes use an exact UTF-8 fallback."""
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
    if codec == "sparse":
        return bytes(sparse)
    if codec == "adaptive" and len(sparse) <= 1 + (len(raw) + 7) // 8:
        return bytes(sparse)
    bitmap = bytearray(1 + (len(raw) + 7) // 8)
    bitmap[0] = ord("B")
    for position in positions:
        bitmap[1 + position // 8] |= 1 << (position % 8)
    return bytes(bitmap)


def restore_case(lower, patch):
    if patch is None:
        return None
    if not patch:
        return lower
    if patch[:1] == b"F":
        return patch[1:].decode("utf-8")
    raw = bytearray(lower.encode("utf-8"))
    if patch[:1] == b"S":
        position = gap = shift = 0
        for byte in patch[1:]:
            gap |= (byte & 127) << shift
            if byte & 128:
                shift += 7
            else:
                position += gap
                raw[position] -= 32
                gap = shift = 0
    elif patch[:1] == b"B":
        for i, byte in enumerate(patch[1:]):
            while byte:
                bit = (byte & -byte).bit_length() - 1
                raw[i * 8 + bit] -= 32
                byte &= byte - 1
    else:
        raise ValueError("unknown case patch format")
    return raw.decode("utf-8")


def variants():
    result = []
    for compressed, casing, selective in itertools.product((False, True), repeat=3):
        name = "_".join(n for n, active in (
            ("zstd", compressed), ("case", casing), ("selected", selective)
        ) if active) or "baseline"
        result.append(dict(name=name, compression="zstd" if compressed else "default",
                           casing=casing, selective=selective, layout="miniblock" if compressed else None))
    result.extend([
        dict(name="layout_only", compression="default", casing=False, selective=False, layout="miniblock"),
        dict(name="originals_zstd", compression="originals", casing=False, selective=False, layout="miniblock"),
        dict(name="case_layout", compression="default", casing=True, selective=False, layout="miniblock"),
    ])
    return result


def probes(root):
    """Small, distributed codec comparison plus compression/layout controls."""
    import lance
    import pyarrow as pa
    from lance.file import LanceFileReader
    source = lance.dataset(str(root / "source-copy.lance"))
    pairs = json.loads((root / "source.json").read_text())["pairs"]
    count = min(4096, source.count_rows())
    offsets = sorted({int(i * max(0, source.count_rows() - count) / 6) for i in range(7)})
    sample = pa.concat_tables([
        source.scanner(offset=offset, limit=count, scan_in_order=True).to_table()
        for offset in offsets
    ])
    result = dict(sample_rows=sample.num_rows, offsets=offsets, codecs=[], compression=[])
    for codec in ("sparse", "bitmap", "adaptive"):
        arrays, payload_bytes, fallbacks = {}, 0, 0
        start = time.monotonic()
        for name in pairs:
            original, lower = sample[name].to_pylist(), sample[name + "__lc"].to_pylist()
            patches = [case_patch(value, low, codec) for value, low in zip(original, lower)]
            assert [restore_case(low, patch) for low, patch in zip(lower, patches)] == original
            payload_bytes += sum(len(p) for p in patches if p is not None)
            fallbacks += sum(p is not None and p[:1] == b"F" for p in patches)
            arrays[name + CASE_SUFFIX] = pa.array(patches, type=pa.binary())
        path = root / f"distributed-codec-{codec}.lance"
        if not path.exists():
            lance.write_dataset(pa.table(arrays), str(path), data_storage_version="2.1")
        result["codecs"].append(dict(codec=codec, payload_bytes=payload_bytes, lance_bytes=sizes(path)["total"],
                                      fallback_values=fallbacks, encode_verify_write_seconds=time.monotonic()-start))
    policies = [
        ("default", {}),
        ("zstd_default_layout", {b"lance-encoding:compression": b"zstd"}),
        ("lz4_default_layout", {b"lance-encoding:compression": b"lz4"}),
        ("miniblock", {b"lance-encoding:structural-encoding": b"miniblock"}),
        ("zstd_miniblock", {b"lance-encoding:compression": b"zstd", b"lance-encoding:structural-encoding": b"miniblock"}),
        ("lz4_miniblock", {b"lance-encoding:compression": b"lz4", b"lance-encoding:structural-encoding": b"miniblock"}),
    ]
    for name, metadata in policies:
        path = root / f"distributed-compression-{name}.lance"
        if not path.exists():
            schema = pa.schema([field.with_metadata(metadata or None) for field in sample.schema])
            lance.write_dataset(sample.cast(schema), str(path), data_storage_version="2.1")
        file = next((path / "data").glob("*.lance"))
        actual = str(LanceFileReader(str(file)).metadata())
        result["compression"].append(dict(policy=name, bytes=sizes(path)["total"],
            encoding_counts={token: actual.count(token) for token in
                             ("Fsst(", "CompressionAlgorithmZstd", "CompressionAlgorithmLz4", "FullZipLayout(", "MiniBlockLayout(")}))
    write_json(root / "probes.json", result)


def sizes(path):
    counts = Counter()
    for file in path.rglob("*"):
        if file.is_file():
            category = "index" if "_indices" in file.parts else "data" if "data" in file.parts else "metadata"
            counts[category] += file.stat().st_size
    return dict(counts, total=sum(counts.values()))


def inventory(root):
    import lance
    found = []
    for directory, children, _ in os.walk(root):
        children[:] = [name for name in children if not name.startswith(".")]
        path = Path(directory)
        if path.suffix != ".lance" or not (path / "_versions").is_dir():
            continue
        children[:] = []
        ds = lance.dataset(str(path))
        pairs = [name[:-4] for name in ds.schema.names if name.endswith("__lc") and name[:-4] in ds.schema.names]
        if pairs:
            found.append(dict(path=str(path), sizes=sizes(path), rows=ds.count_rows(), pairs=pairs,
                              version=ds.version, schema=str(ds.schema)))
    return sorted(found, key=lambda item: item["sizes"]["total"], reverse=True)


def output_schema(source, variant, pairs):
    import pyarrow as pa
    fields = []
    for field in source.schema:
        if field.name.endswith("__lc") and field.name[:-4] in pairs:
            if variant["casing"] or (variant["selective"] and field.name[:-4] not in SELECTED):
                continue
        metadata = {k: v for k, v in (field.metadata or {}).items() if not k.startswith(b"lance-encoding:")}
        compress = variant["compression"] == "zstd" or (variant["compression"] == "originals" and field.name in pairs)
        layout = variant["layout"] if variant["compression"] != "originals" or compress else None
        if compress:
            metadata[b"lance-encoding:compression"] = b"zstd"
        if layout:
            metadata[b"lance-encoding:structural-encoding"] = layout.encode()
        fields.append(field.with_metadata(metadata or None))
    if variant["casing"]:
        for name in pairs:
            metadata = ({b"lance-encoding:compression": b"zstd",
                         b"lance-encoding:structural-encoding": b"miniblock"}
                        if variant["compression"] == "zstd" else None)
            fields.append(pa.field(name + CASE_SUFFIX, pa.binary(), metadata=metadata))
    return pa.schema(fields, metadata=source.schema.metadata)


def transformed_batches(source, schema, variant, pairs, limit=None, codec_counts=None):
    import pyarrow as pa
    for batch in source.scanner(batch_size=8192, limit=limit, scan_in_order=True).to_batches():
        arrays = {}
        for field in schema:
            name = field.name
            if name.endswith(CASE_SUFFIX):
                original = name[:-len(CASE_SUFFIX)]
                patches = []
                for value, lower in zip(batch[original].to_pylist(), batch[original + "__lc"].to_pylist()):
                    patch = case_patch(value, lower)
                    if restore_case(lower, patch) != value:
                        raise AssertionError("case codec failed exact reconstruction")
                    patches.append(patch)
                    if codec_counts is not None:
                        codec_counts[(patch[:1] or b"unchanged").decode() if patch is not None else "null"] += 1
                arrays[name] = pa.array(patches, type=pa.binary())
            else:
                read_name = name + "__lc" if variant["casing"] and name in pairs else name
                arrays[name] = batch[read_name]
        yield pa.RecordBatch.from_arrays([arrays[f.name] for f in schema], schema=schema)


def logical_hashes(ds, pairs, casing=False):
    """Full, order-sensitive verification of every visible value after reading."""
    names = [name for name in ds.schema.names if not name.endswith(("__lc", CASE_SUFFIX))]
    digests = {name: hashlib.sha256() for name in names}
    rows = 0
    for batch in ds.scanner(batch_size=16384, scan_in_order=True).to_batches():
        rows += batch.num_rows
        for name in names:
            values = batch[name].to_pylist()
            if casing and name in pairs:
                values = [restore_case(value, patch) for value, patch in zip(values, batch[name + CASE_SUFFIX].to_pylist())]
            digest = digests[name]
            for value in values:
                if value is None:
                    digest.update(b"\xff" * 8)
                else:
                    raw = value.encode("utf-8") if isinstance(value, str) else str(value).encode()
                    digest.update(len(raw).to_bytes(8, "little"))
                    digest.update(raw)
    return dict(rows=rows, columns={name: digest.hexdigest() for name, digest in digests.items()})


def build(root, source, variant, pairs, reference, limit=None):
    import lance
    import pyarrow as pa
    name = variant["name"]
    marker = root / f"{name}.build.json"
    path = root / f"{name}.lance"
    if marker.exists():
        return json.loads(marker.read_text())
    started = time.monotonic()
    schema = output_schema(source, variant, pairs)
    counts = Counter()
    data_marker = root / f"{name}.data.json"
    if not data_marker.exists():
        log(f"{name}: writing independent dataset")
        reader = pa.RecordBatchReader.from_batches(schema, transformed_batches(source, schema, variant, pairs, limit, counts))
        ds = lance.write_dataset(reader, str(path), data_storage_version="2.1", max_rows_per_file=1048576)
        write_json(data_marker, dict(seconds=time.monotonic() - started, codec_counts=dict(counts)))
    else:
        ds = lance.dataset(str(path))
    indexing = []
    for index in source.list_indices():
        column = index["fields"][0]
        logical = column[:-4] if column.endswith("__lc") else column
        if variant["selective"] and logical not in SELECTED:
            continue
        if index["type"] != "NGram":
            raise ValueError(f"benchmark expects NGram indexes: {index}")
        target = logical if variant["casing"] and logical in pairs else column
        if any(i["fields"] == [target] for i in ds.list_indices()):
            continue
        log(f"{name}: indexing {target}")
        t = time.monotonic()
        ds.create_scalar_index(target, "NGRAM", replace=True)
        indexing.append(dict(column=target, seconds=time.monotonic() - t))
    ds.cleanup_old_versions(older_than=timedelta(0), delete_unverified=True)
    log(f"{name}: checking every original value after reading")
    observed = logical_hashes(ds, pairs, variant["casing"])
    if observed != reference:
        raise AssertionError(f"{name}: full dataset verification failed")
    # Capture actual encodings, not just requested metadata flags.
    from lance.file import LanceFileReader
    file = next((path / "data").glob("*.lance"))
    metadata = LanceFileReader(str(file)).metadata()
    encodings = [page.encoding for column in metadata.columns for page in column.pages]
    result = dict(variant=variant, path=str(path), sizes=sizes(path),
                  data=json.loads(data_marker.read_text()), index_builds=indexing,
                  build_seconds=time.monotonic() - started, verification=observed,
                  encoding_counts={token: sum(str(e).count(token) for e in encodings)
                                   for token in ("Fsst(", "CompressionAlgorithmZstd", "FullZipLayout(", "MiniBlockLayout(")})
    write_json(marker, result)
    log(f"{name}: ready, {result['sizes']['total'] / 1024**3:.2f} GiB")
    return result


WORKLOADS = [
    ("prompt_common", [("prompt", "blue", False)]),
    ("prompt_rare", [("prompt", "steampunk", False)]),
    ("prompt_and", [("prompt", "blue", False), ("prompt", "sword", False)]),
    ("prompt_exclude", [("prompt", "blue", False), ("prompt", "sky", True)]),
    ("tags_common", [("tags", "blue", False)]),
    ("character", [("character", "hatsune miku", False)]),
    ("full_search", [("full", "steampunk", False)]),
    ("general_search", [("general", "blue", False)]),
    ("short_term", [("prompt", "xy", False)]),
    ("no_match", [("prompt", "quarrybenchmarknomatchzzzz", False)]),
]


def predicate(ds, terms, pairs, casing):
    indexed = {field for index in ds.list_indices() for field in index["fields"]}
    clauses, parameters = [], []
    for column, value, negate in terms:
        companion = column + "__lc"
        if len(value) >= 3 and companion in indexed:
            expression = f'"{companion}"'
        elif len(value) >= 3 and column in indexed:
            expression = f'"{column}"'
        else:
            expression = f'lower("{column}")'
        clauses.append(("NOT " if negate else "") + f"contains({expression}, ?)")
        parameters.append(value.lower())
    return " AND ".join(clauses), parameters


def drop_file_cache(path):
    """Advisory eviction of only our copy; does not flush global kernel caches."""
    count = 0
    for file in path.rglob("*"):
        if file.is_file():
            with file.open("rb") as handle:
                os.posix_fadvise(handle.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
            count += 1
    return count


def measure_worker(root, name, repeats, seed):
    import duckdb
    import lance
    info = json.loads((root / f"{name}.build.json").read_text())
    path = Path(info["path"])
    variant = info["variant"]
    casing = variant["casing"]
    pairs = json.loads((root / "source.json").read_text())["pairs"]
    con = duckdb.connect()
    con.execute("LOAD lance")
    con.execute("SET threads=8")
    ds = lance.dataset(str(path))
    table = "'" + str(path).replace("'", "''") + "'"
    projection = '"prompt", "prompt__case"' if casing else '"prompt"'
    records = []
    plans = {}
    rng = random.Random(seed)

    def timed(sql, params=(), restore=False):
        start = time.perf_counter_ns()
        rows = con.execute(sql, params).fetchall()
        fetched = time.perf_counter_ns()
        if restore and casing:
            rows = [(restore_case(row[0], row[1]),) for row in rows]
        end = time.perf_counter_ns()
        return rows, (end - start) / 1e6, (end - fetched) / 1e6

    for repetition in range(repeats + 1):
        order = list(WORKLOADS)
        rng.shuffle(order)
        for query, terms in order:
            where, params = predicate(ds, terms, pairs, casing)
            count_sql = f"SELECT count(*) FROM {table} WHERE {where}"
            fetch_sql = f"SELECT {projection} FROM {table} WHERE {where} LIMIT 25"
            matches, count_ms, _ = timed(count_sql, params)
            rows, fetch_ms, decode_ms = timed(fetch_sql, params, restore=True)
            # A fixed mid-result offset approximates a cached-count random pick.
            offset = matches[0][0] // 2
            picked, pick_ms, pick_decode_ms = timed(
                f"SELECT {projection} FROM {table} WHERE {where} LIMIT 1 OFFSET {offset}", params, restore=True
            )
            # Mirror PromptSampler's strategy: up to 48 direct row probes when
            # at least 1/48 of the dataset matches, otherwise a filtered offset.
            # The seeded offsets are identical across variants; Python's RNG is
            # used rather than claiming the same seed sequence as .NET Random.
            attempts = 0
            used_offset = True
            sampled, sampler_ms, sampler_decode_ms = picked, pick_ms, pick_decode_ms
            total = ds.count_rows()
            if matches[0][0] > 0 and total <= matches[0][0] * 48:
                candidate_rng = random.Random(f"{seed}:{repetition}:{query}")
                start = time.perf_counter_ns()
                sampler_decode_ms = 0.0
                for attempt in range(48):
                    attempts += 1
                    candidate = candidate_rng.randrange(total)
                    candidates = con.execute(
                        f"SELECT {projection}, ({where}) FROM {table} LIMIT 1 OFFSET {candidate}", params
                    ).fetchall()
                    if not candidates:
                        continue
                    row = candidates[0]
                    decoding = time.perf_counter_ns()
                    value = restore_case(row[0], row[1]) if casing else row[0]
                    sampler_decode_ms += (time.perf_counter_ns() - decoding) / 1e6
                    if row[-1] and value and value.strip():
                        sampled, used_offset = [(value,)], False
                        break
                if used_offset:
                    sampled, _, extra_decode = timed(
                        f"SELECT {projection} FROM {table} WHERE {where} LIMIT 1 OFFSET {offset}", params, restore=True
                    )
                    sampler_decode_ms += extra_decode
                sampler_ms = (time.perf_counter_ns() - start) / 1e6
            records.append(dict(query=query, repetition=repetition, matches=matches[0][0],
                                count_ms=count_ms, fetch25_ms=fetch_ms, pick_ms=pick_ms,
                                decode25_ms=decode_ms, decode_pick_ms=pick_decode_ms,
                                sampler_ms=sampler_ms, sampler_decode_ms=sampler_decode_ms,
                                sampler_attempts=attempts, sampler_used_offset=used_offset,
                                sampler_sha256=hashlib.sha256(json.dumps(sampled).encode()).hexdigest(),
                                preview_sha256=hashlib.sha256(json.dumps(rows).encode()).hexdigest(),
                                pick_sha256=hashlib.sha256(json.dumps(picked).encode()).hexdigest()))
            if repetition == repeats:
                plans[query] = con.execute("EXPLAIN " + count_sql, params).fetchall()
        # Unfiltered prompt insertion at several deterministic row offsets.
        for offset in (0, ds.count_rows() // 2, max(0, ds.count_rows() - 1)):
            rows, elapsed, decode = timed(f"SELECT {projection} FROM {table} LIMIT 1 OFFSET {offset}", restore=True)
            records.append(dict(query=f"unfiltered_{offset}", repetition=repetition, pick_ms=elapsed,
                                decode_pick_ms=decode,
                                pick_sha256=hashlib.sha256(json.dumps(rows).encode()).hexdigest()))
    con.close()
    write_json(root / f"{name}.timings.json", dict(records=records, plans=plans, seed=seed,
        note="Repetition 0: fresh process/connection after advisory file eviction; later queries can reuse pages. Others: warm process. Not a guaranteed cold-disk test."))


def report(root):
    source = json.loads((root / "source.json").read_text())
    builds = [json.loads(p.read_text()) for p in root.glob("*.build.json")]
    baseline = next(b for b in builds if b["variant"]["name"] == "baseline")
    lines = ["# Lance storage benchmark", "", f"Source: `{source['path']}`", "",
             f"Rows: {source['rows']:,}; original size: {source['sizes']['total'] / 1024**3:.2f} GiB.", "",
             "All test datasets are independent copies. Every visible value is checked by an order-sensitive SHA-256 digest, including reconstructed casing.", "",
             "## Storage", "", "| Variant | Total GiB | Data GiB | Index GiB | vs rewritten baseline | Build seconds |",
             "|---|---:|---:|---:|---:|---:|"]
    for build in sorted(builds, key=lambda b: b["sizes"]["total"]):
        size = build["sizes"]
        lines.append(f"| {build['variant']['name']} | {size['total']/1024**3:.3f} | {size.get('data',0)/1024**3:.3f} | {size.get('index',0)/1024**3:.3f} | {(size['total']/baseline['sizes']['total']-1)*100:+.1f}% | {build['build_seconds']:.1f} |")
    if (root / "probes.json").exists():
        probe = json.loads((root / "probes.json").read_text())
        lines.extend(["", "## Distributed sample: casing representation", "",
                      f"{probe['sample_rows']:,} sampled rows from evenly spaced windows; both prompt and full are included. These sizes include only the casing columns, without indexes.", "",
                      "| Codec | Raw patch bytes | Lance bytes | Unicode/mismatch fallback values |",
                      "|---|---:|---:|---:|"])
        for item in probe["codecs"]:
            lines.append(f"| {item['codec']} | {item['payload_bytes']:,} | {item['lance_bytes']:,} | {item['fallback_values']} |")
        lines.extend(["", "## Distributed sample: native compression", "",
                      "Identical sampled rows, no indexes. Requested codec labels do not necessarily describe actual on-disk encodings in this Lance release; see probes.json for observed encodings.", "",
                      "| Requested policy | Data and metadata bytes |", "|---|---:|"])
        for item in probe["compression"]:
            lines.append(f"| {item['policy']} | {item['bytes']:,} |")
    timing_files = list(root.glob("*.timings.json"))
    if timing_files:
        reference = json.loads((root / "baseline.timings.json").read_text()) if (root / "baseline.timings.json").exists() else None
        expected = {r["query"]: r for r in reference["records"] if r["repetition"] == 0} if reference else {}
        expected_by_repeat = {(r["query"], r["repetition"]): r for r in reference["records"]} if reference else {}
        for file in timing_files:
            for row in json.loads(file.read_text())["records"]:
                expected_row = expected_by_repeat.get((row["query"], row["repetition"]))
                if expected_row:
                    for key in ("matches", "preview_sha256", "pick_sha256", "sampler_sha256"):
                        if key in row and key in expected_row and row[key] != expected_row[key]:
                            raise AssertionError(f"result mismatch: {file.stem} {row['query']} repetition {row['repetition']} {key}")
        lines.extend(["", "## First query in a fresh process", "",
                      "After advisory eviction of each copy's files. Only the first query is shown: subsequent queries can share cached pages. These are single observations, not guaranteed cold-disk measurements.", "",
                      "| Variant | Query | Count ms | Fetch 25 ms |", "|---|---|---:|---:|"])
        for file in sorted(timing_files):
            first = json.loads(file.read_text())["records"][0]
            lines.append(f"| {file.name.removesuffix('.timings.json')} | {first['query']} | {first['count_ms']:.2f} | {first['fetch25_ms']:.2f} |")
        lines.extend(["", "## Unfiltered prompt reads", "",
                      "Warm reads at the first, middle, and last row; reconstruction is included.", "",
                      "| Variant | Median ms | Maximum ms | Median decode ms |", "|---|---:|---:|---:|"])
        for file in sorted(timing_files):
            reads = [r for r in json.loads(file.read_text())["records"]
                     if r["query"].startswith("unfiltered_") and r["repetition"] > 0]
            if reads:
                lines.append(f"| {file.name.removesuffix('.timings.json')} | {statistics.median(r['pick_ms'] for r in reads):.3f} | {max(r['pick_ms'] for r in reads):.3f} | {statistics.median(r['decode_pick_ms'] for r in reads):.3f} |")
        lines.extend(["", "## Warm query medians (milliseconds)", "", "Sampler mirrors Quarry's 48-attempt rejection sampling threshold and filtered-offset fallback. Count + sampler approximates a new filtered-count lookup and prompt selection; sampler alone approximates a cached count. Candidate offsets are seeded identically across variants, using Python's RNG. C# routing/caches, prompt parsing, network, and model inference are excluded.", ""])
        for query, _ in WORKLOADS:
            lines.extend([f"### {query}", "", "| Variant | Matches | Count | Fetch 25 | Offset pick | Sampler | Count + sampler | Decode sampler |", "|---|---:|---:|---:|---:|---:|---:|---:|"])
            for file in sorted(timing_files):
                results = json.loads(file.read_text())
                records = [r for r in results["records"] if r["query"] == query and r["repetition"] > 0]
                if not records:
                    continue
                for row in records:
                    if expected and any(row[key] != expected[query][key] for key in ("matches", "preview_sha256", "pick_sha256")):
                        raise AssertionError(f"query results differ: {file.stem} {query}")
                    reference_row = expected_by_repeat.get((query, row["repetition"]))
                    if reference_row and "sampler_sha256" in row and "sampler_sha256" in reference_row:
                        if row["sampler_sha256"] != reference_row["sampler_sha256"]:
                            raise AssertionError(f"sampled prompt differs: {file.stem} {query}")
                med = lambda key: statistics.median(r[key] for r in records)
                name = file.name.removesuffix(".timings.json")
                sampler_key = "sampler_ms" if "sampler_ms" in records[0] else "pick_ms"
                decode_key = "sampler_decode_ms" if "sampler_decode_ms" in records[0] else "decode_pick_ms"
                lines.append(f"| {name} | {records[0]['matches']:,} | {med('count_ms'):.2f} | {med('fetch25_ms'):.2f} | {med('pick_ms'):.2f} | {med(sampler_key):.2f} | {statistics.median(r['count_ms']+r[sampler_key] for r in records):.2f} | {med(decode_key):.3f} |")
    lines.extend(["", "## Interpretation and limits", "",
        "- `zstd`: Zstandard with miniblock layout; `layout_only` separates the layout effect from compression.",
        "- `originals_zstd`: compress only original prompt/full columns; leave search companions on their default encoding.",
        "- `case_layout`: follow-up control combining case patches with miniblock layout and default compression, isolating the extra Zstandard cost from layout changes.",
        "- `case`: replace prompt/full duplicates with searchable lowercase text and adaptive sparse/bitmap casing patches; UTF-8 fallback preserves Unicode exactly. This needs a Quarry decoder before production use.",
        "- `selected`: keep prompt, tags, character, copyright indexes. Drop full's search companion and full/general/rating indexes. Those fields remain searchable through scans. This is a workload assumption, not a usage recommendation.",
        "- Compression uses file format 2.1 for compatibility with the installed DuckDB Lance extension. Actual file encodings are recorded in build JSON.",
        "- Timings use DuckDB with 8 threads. Variants run sequentially in seeded randomized order. Three warm repetitions by default; inspect raw timings before treating small differences as meaningful.",
        "- Advisory eviction affects only benchmark-copy files. Fresh-process results are not guaranteed cold-disk results; query order and OS caches matter.",
        "- Per-query counts and returned prompt hashes must match baseline. Full output hashes verify every visible value independently of query sampling.",
        "- Copies use the workspace filesystem, not the source dataset's filesystem. Compare variants with each other, not as a prediction of absolute production latency.",
        "- Build durations include verification and index construction. Source is never modified. Temporary disk usage is higher than final reported size.", ""])
    (root / "REPORT.md").write_text("\n".join(lines))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("run", "build", "measure", "worker", "report", "inventory", "probe"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--data-root", type=Path, default=Path.home() / "data/AIConfigs/Quarry")
    parser.add_argument("--limit", type=int, help="smoke test only; omitted means the entire dataset")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--name", help="one variant, or worker target")
    parser.add_argument("--seed", type=int, default=20260916)
    args = parser.parse_args()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    import lance
    import pyarrow as pa
    pa.set_cpu_count(8)
    pa.set_io_thread_count(8)
    if args.action == "probe":
        probes(root)
        return
    if args.action == "worker":
        measure_worker(root, args.name, args.repeats, args.seed)
        return
    if args.action == "report":
        report(root)
        return
    if args.action in ("run", "build", "inventory"):
        if not (root / "source.json").exists():
            datasets = inventory(args.data_root.resolve())
            write_json(root / "inventory.json", datasets)
            if not datasets:
                raise SystemExit("No datasets with matching __lc columns")
            selected = datasets[0]
            selected["limit"] = args.limit
            selected["python"] = sys.version
            selected["lance"] = lance.__version__
            import duckdb
            selected["duckdb"] = duckdb.__version__
            write_json(root / "source.json", selected)
        source_info = json.loads((root / "source.json").read_text())
        if args.action == "inventory":
            print(json.dumps(source_info, indent=2))
            return
        if source_info["limit"] != args.limit:
            raise SystemExit("Use a separate root for a different row limit")
        original = Path(source_info["path"])
        if root == original or original in root.parents or root in original.parents:
            raise SystemExit("Benchmark directory must be separate from the source")
        frozen_path = root / "source-copy.lance"
        if not (root / "copy.json").exists():
            log("Copying source to benchmark filesystem (no hard links)")
            shutil.copytree(original, frozen_path)
            frozen = lance.dataset(str(frozen_path))
            if frozen.version != source_info["version"]:
                raise AssertionError("source changed during snapshot")
            write_json(root / "copy.json", dict(sizes=sizes(frozen_path), version=frozen.version))
        frozen = lance.dataset(str(frozen_path))
        if not (root / "reference.json").exists():
            log("Hashing every source value")
            if args.limit:
                reference_path = root / "sample-reference.lance"
                frozen = lance.write_dataset(frozen.head(args.limit), str(reference_path))
            write_json(root / "reference.json", logical_hashes(frozen, source_info["pairs"]))
        if args.limit:
            frozen = lance.dataset(str(frozen_path))
        reference = json.loads((root / "reference.json").read_text())
        for variant in variants():
            if args.name and variant["name"] != args.name:
                continue
            build(root, frozen, variant, source_info["pairs"], reference, args.limit)
    if args.action in ("run", "measure"):
        names = [v["name"] for v in variants() if not args.name or v["name"] == args.name]
        random.Random(args.seed).shuffle(names)
        for name in names:
            if (root / f"{name}.timings.json").exists():
                continue
            log(f"{name}: measuring DuckDB filters and prompt reads")
            drop_file_cache(root / f"{name}.lance")
            subprocess.run([sys.executable, str(Path(__file__).resolve()), "worker", "--root", str(root),
                            "--name", name, "--repeats", str(args.repeats), "--seed", str(args.seed)], check=True)
    report(root)


if __name__ == "__main__":
    main()
