# Lance storage experiments

From the extension root:

```bash
.venv/bin/python scripts/benchmarks/lance_storage.py run \
  --root .cache/benchmarks/lance-storage-20260916
```

The runner inventories `~/data/AIConfigs/Quarry`, selects the largest dataset
containing an original/`__lc` pair, makes an independent copy, and builds the full
matrix below. The source is only read. Large copies belong on disk, not `/tmp`.
Allow roughly twelve times the source size for the snapshot and variants, plus
temporary files during index building. Completed stages have JSON markers and
are skipped on reruns. Keep the same source, parameters, and script when resuming.

## Full-dataset matrix

| Variant | Native encoding | Case representation | Indexes |
|---|---|---|---|
| baseline | Lance default | original + lowercase | all original indexes |
| selected | Lance default | original + required lowercase | selected |
| case | Lance default | lowercase + lossless case patches | all |
| case_selected | Lance default | lowercase + lossless case patches | selected |
| zstd | Zstandard, miniblock | original + lowercase | all |
| zstd_selected | Zstandard, miniblock | original + required lowercase | selected |
| zstd_case | Zstandard, miniblock | lowercase + lossless case patches | all |
| zstd_case_selected | Zstandard, miniblock | lowercase + lossless case patches | selected |
| layout_only | miniblock, default compression | original + lowercase | all |
| originals_zstd | only original prompt/full use Zstandard miniblocks | original + lowercase | all |
| case_layout | miniblock, default compression | lowercase + lossless case patches | all |

`selected` retains indexes on `prompt`, `tags`, `character`, and `copyright`.
It removes other indexes and unnecessary lowercase companions, while preserving
the original values. Queries against excluded fields are measured too, to expose
the cost of scanning. This choice is an explicit benchmark workload assumption.

The compression treatment includes the miniblock layout, with `layout_only` as a
control. A small initial probe found that merely requesting Zstandard on the
default layout increased file size. The full matrix uses file format 2.1, verified
readable by the installed DuckDB Lance extension.

`case_layout` is a follow-up control: the initial matrix showed faster common
filter counts with the smaller-block layout alone than with Zstandard. This
additional combination checks whether case patches can retain that advantage.

The experimental case codec records delta-encoded ASCII-capital byte offsets or
a bitmask, whichever is smaller. It falls back to the exact original UTF-8 string
when bytewise ASCII lowercasing cannot reproduce the existing companion. These
datasets require the experimental decoder; do not use them directly in Quarry.

## Measurements

- Full order-sensitive hashes of every visible column after reading each variant.
- Physical data/index/metadata sizes after removal of old versions.
- Build times, codec frequencies, and observed file encodings.
- DuckDB `contains` filters matching Quarry's index routing and short-term scan.
- Common, rare, AND, exclusion, tag, character, omitted-index, no-match, and
  two-character searches.
- Counts, first 25 results, one result at the middle matching offset, and
  unfiltered reads at three row offsets. Decode time is included and recorded
  separately. Filter counts and output hashes must match baseline.
- Quarry's prompt sampler strategy: 48 direct candidate probes when selectivity
  is at least 1/48, followed by the filtered-offset fallback if needed. Candidates
  use deterministic Python RNG offsets shared across variants, not .NET's seed
  sequence. Report both cached-count sampling and count-plus-sampling time.
- One fresh process per variant after advisory eviction of that copy's files,
  then three warm repetitions. Advisory eviction is not a guaranteed cold-disk
  test. Variant/query order is seeded and randomized; no builds overlap timing.

The benchmark measures backend operations rather than complete generation time.
The prototype decoder is Python, not a finished C# implementation. All copies use
the same workspace filesystem; absolute latency may differ on the production
data volume. Small timing differences need more repetitions before acting on them.

## Separate stages and probes

```bash
.venv/bin/python scripts/benchmarks/lance_storage.py build --root .cache/benchmarks/lance-storage-20260916
.venv/bin/python scripts/benchmarks/lance_storage.py probe --root .cache/benchmarks/lance-storage-20260916
.venv/bin/python scripts/benchmarks/lance_storage.py measure --root .cache/benchmarks/lance-storage-20260916
.venv/bin/python scripts/benchmarks/lance_storage.py report --root .cache/benchmarks/lance-storage-20260916
```

`probe` compares sparse positions, bitmasks, adaptive patches, and native encoding
settings on seven evenly spaced windows from the frozen copy. Results are saved
in `probes.json`. Use a different `--root` and `--limit 20000` for a short smoke
test; row-limited runs are not full-dataset results.

Outputs: `REPORT.md`, `inventory.json`, `source.json`, `reference.json`, per-variant
`*.build.json` and `*.timings.json`, and the independent `.lance` directories.
Existing timing files are reused; use a new root for an independent benchmark run.

## Production C# casing validation

After `./run-tests`, compare independent, logically identical `baseline.lance` and
`optimized.lance` copies using the compiled production backend and actual sampler:

```bash
.venv/bin/python scripts/benchmarks/casing_reads.py /tmp/quarry-casing-production \
  --assemblies /tmp/swarmui-msbuild/SwarmUI-Quarry.Tests/bin/Debug/net8.0
```

Adjust `--assemblies` to the test output directory printed by your build. This
Linux harness compiles only a small executable against those existing binaries.
Its assembly name enables the same internal sampler access as the unit tests.
It performs one warm-up and five measured repetitions in alternating variant
order, verifies counts and hashes of original output text, and writes raw results
to `.cache/benchmarks/casing-production-reads.json`. It does not mutate datasets.
A tmpfs root measures warm query/decoding cost; use copies on the same disk when
investigating storage latency. Migration and tests should finish before timings.

The completed production run is summarized in `.cache/benchmarks/CASING-PRODUCTION.md`.
