# Quarry storage: flat casing and structured search

Quarry keeps logical values separate from derived search data. Flat strings use
the existing lossless casing codec. Direct objects and arrays of direct objects
keep their native types and original scalar values, including original casing.
Arrays retain all records, null slots, and their order. Bare arrays and `[]`
search any record and print all records; numbered and named selectors restrict
selection without changing storage.

## Flat casing codec (version 1)

`quarry-storage.json` is required alongside the Lance dataset's data and manifests:

```json
{"version":1,"columns":{"prompt":"prompt__case"}}
```

Each mapping identifies a string or large-string field and its binary casing
companion. The suffix alone is not a format marker. Unknown versions, overlapping
mappings, conflicting names, and invalid types are rejected. Logical columns keep
their original names/order. Companions follow the logical columns and are internal.

The text is lowercased using DuckDB `lower`; encoded search also applies DuckDB
`lower` to the query parameter. Text fields request
`lance-encoding:structural-encoding = miniblock`, with default compression in Lance
format 2.2, which supports miniblock chunks larger than format 2.1's 32 KiB limit.
Existing optimized format-2.1 datasets remain readable and eligible for skipping.
If optimization hits a miniblock size error or its known native writer panic,
it retries with 1,024-row input batches, then with Lance's default layout if needed.
Each retry restarts the temporary dataset; casing and index guarantees are unchanged.
Binary patches use default encoding. Flat text fields get NGRAM indexes. Only
query terms composed entirely of ASCII letters/digits, with at least three
characters, use the indexed route. Other terms, including phrases containing
spaces or punctuation and non-ASCII terms, scan to preserve substring semantics.
Reconstruction happens only for returned values, before trimming, labels, or
joining prompt columns.

## Patch bytes

| Patch | Meaning |
| --- | --- |
| null | Original and lowercase text are both null. |
| empty | Original equals stored lowercase text. |
| ASCII `S` + unsigned LEB128 deltas | UTF-8 byte positions of ASCII uppercase letters, relative to the preceding position (initial position zero). |
| ASCII `B` + bitmap | One bit per UTF-8 byte, least significant bit first; exactly `ceil(byte_length / 8)` bitmap bytes. |
| ASCII `F` + UTF-8 bytes | Complete original text, preserved verbatim. |

`S` and `B` restore only ASCII `a`–`z` by subtracting 32 at marked positions. The
encoder selects the smaller, preferring `S` on ties. UTF-8 continuation bytes
cannot overlap ASCII letters. When lowering changes non-ASCII bytes (including
Unicode casing expansions), `F` stores the exact original, without normalization.
Malformed offsets, bitmaps, varints, null combinations, UTF-8, and unknown tags
raise errors. Implementations share fixtures in `Tests/Fixtures/casing-v1.json`.

## Structured columns and descriptor version 2

Structured datasets use a version-2 `quarry-storage.json`. Its `columns` mapping
retains the version-1 flat casing codec without changing its patch bytes.
Nested text is **not** lowercased in its original record, and has no casing patch.
Instead, `helpers` maps each nested text field to one hidden scalar search column:

```json
{"column":"prompt","field":"hair_color","kind":"list","physical":"__quarry_search_0"}
```

This is one mapping entry, not a complete descriptor. `kind` is `object` or
`list`; separate column and field names avoid ambiguous dotted-path encoding.
Names are allocated and validated by Quarry. The descriptor identifies internal
columns; a similar-looking suffix or prefix alone is not sufficient.

Each helper contains that field's lowercase values from all records in a source
row, separated by U+001F, and gets a scalar NGRAM index. Numeric
and boolean leaves retain their native types and do not receive text helpers.
The layout is generic: a schema with 13 text fields produces 13 helpers, not one
helper per array index or named variable. Helpers are hidden from column lists,
autocomplete, prompt output, and previews. They duplicate some searchable text,
so indexed structured datasets can be larger than their unindexed inputs.
Generation and verification decode each source record column once per batch and
reuse those records across its helpers. Search uses DuckDB lowercase rules;
complete-prompt deduplication uses the separate Python normalization below.

For a positive nested search term, Quarry can narrow candidate rows using the
longest literal ASCII alphanumeric run of at least three characters. It then
evaluates the complete substring predicate against the original records. A
fixed index, wildcard, shared binding, distinct binding, or first complete
assignment retains exactly its original meaning. Negative predicates are never
implemented by negating an approximate helper match. Short terms and terms
without a safe ASCII run use the exact path. Candidates are not final matches:
counts, previews, offsets, and sampling all use the complete predicate.

### Query execution constraints

With Lance 7.0.0, DuckDB 1.5.3 and Lance reader commit `533e0ee`, native struct
NGRAM indexes did not accelerate substring queries, and list-of-struct paths
could not be indexed. Scalar helpers provided working indexed candidates.
The tokenizer also missed literal punctuation/whitespace needles such as `a-b`,
`a b` and `!!!`; length alone does not make a term safe for index routing.
Retain exact-versus-indexed regression coverage when upgrading dependencies.

Candidate predicates preserve OR structure: any branch without a safe restriction
makes that OR unrestricted. Independent AND conditions can still narrow candidates.
Matches spanning helper boundaries are harmless false positives because the full
predicate is checked against the original record.

Materialize candidates before correlated record matching; SQL AND evaluation order
does not guarantee this. Exact scan fallbacks also materialize before nested
predicates and LIMIT to avoid a verified selection-vector bug in that Lance reader.
Physical sampling selects and materializes its raw row before matching. Counts,
ordered output, filtered offsets and sampling must agree on eligible source rows;
candidate counts cannot substitute for exact counts. Output eligibility uses the
same whitespace rules as rendering. Broad queries can cost more with candidate
materialization, so indexing does not guarantee acceleration for every query.

Prepared datasets disable stable row IDs. Native `_rowid` ordering then matches
physical scan order, including tested compaction and rewrite cases. Stable-ID
compaction broke that contract; those external datasets use exact scans until
rewritten. IDs can have gaps: physical offset n is not `_rowid = n`. Filtered
offsets explicitly order by row identity, and maintenance invalidates cached row
identities and sampling state.

### Snapshot integrity

The descriptor separately records `search_version`, `data_storage_version`,
`stable_row_ids`, helper-index completion, and `optimized`. Finalization verifies
logical values, helper contents, complete required indexes, physical row IDs,
and a single current manifest. `snapshot` identifies that manifest by relative
path and SHA-256. These fields are written by Quarry after verification.
Readers enumerate the manifest directory and require exactly one manifest rather
than trusting an arbitrary descriptor path or `latest_version_hint.json`. A Lance
version number or rebuilt index alone cannot establish helper freshness. Snapshot
checks cover normal Lance commits, including index-only changes, not arbitrary
in-place file tampering. Version-1 compatibility does not imply this guarantee.

If a snapshot no longer matches, helpers are not trusted. With original nested
values and no flat casing mappings, reads fall back to exact matching and
`./quarry lance optimize DATASET.lance` can regenerate derived search data.
When flat casing mappings also exist, reads fail with a rebuild-from-original
error: a stale descriptor cannot establish that casing patches still belong to
their text. An invalid authoritative casing mapping is likewise an error, not
a reason to return physical lowercase text. Never hand-edit the snapshot to
make an externally changed dataset appear verified.

## Input validation and complete-prompt deduplication

JSON/JSONL discovery reads all source rows before building explicit types. String
values, including dates written as strings, remain text. Integer fields use an
exact signed or unsigned 64-bit type; incompatible kinds (including integer and
noninteger numbers in one field), numeric overflow, duplicate names differing
only by case, and unsupported nesting fail with their field path. Noninteger
numbers use finite double precision. Scalar lists retain their legacy support;
records may contain only direct scalar fields.
Runtime JSON reads use the same discovery policy as prep. DuckDB cannot represent
an empty STRUCT: a wholly schema-less empty prompt produces a zero-row dataset
with a nullable text prompt placeholder. A selected nonprompt complex column with
no discoverable fields is rejected. All-null scalar fields use nullable text;
null/empty record slots remain supported when another record defines the schema.

Preparation compares every record in a structured prompt, preserving schema
field identities, scalar types, nulls, value boundaries, array positions, and
repeated records. Each text leaf uses the existing `lower()` plus `isalnum()`
normalization. `[A, B]` therefore differs from `[A, C]`, `[B, A]`, and `[A]`, even
when explicit output selects only A. The earliest equivalent source row survives
with its original values and metadata. Wholly punctuation-only text prompts
retain the existing deduplication exception. Emptiness also considers every
record: a blank first record does not discard a populated later record.
Versioned canonical BLOB keys encode the complete typed prompt in bounded batches;
DuckDB groups by full keys and retains the minimum source ordinal, restoring source
order. Metadata outside the prompt does not affect equality. Cleanup preserves
legacy emptiness rules: ASCII-space-only text is empty, while tabs, zero and false
contribute content. This differs from output trimming.

Unified schema order controls field output order; source array order is retained.
Missing and explicit-null fields become the same logical null after schema
alignment. Optimize does not perform this cleanup or deduplication.

## Operations and compatibility

Migration writes a new sibling dataset, verifies all logical values and required
indexes, removes historical versions, then publishes it. A temporary original is
retained only through publication/rollback. A process or machine crash can leave
`.quarry-optimize-*` or `.quarry-reindex-*` work directories; if publication was interrupted, the original
may be at `original.lance` inside that directory. Do not remove it until recovery.
There is no concurrent reader/writer guarantee during directory replacement.
Publication verifies complete logical values and order through both Python Lance
and the DuckDB Lance reader; Python reading its own output is insufficient.

For prepared version-2 datasets, `quarry lance prep DATASET.lance --no-clean`
rebuilds indexes in a staged copy, verifies helpers and logical values, and
finalizes a fresh snapshot before replacement. It rechecks source descriptor and
manifest identity before publication, rolls back failed publication, and retains
the original if recovery cannot complete. Indexing failures and cancellation
leave the published dataset untouched.

Completed optimization and prep also write an `optimized` object to the descriptor:
`{"version":1,"lance_version":3}` (the Lance version varies per dataset).
This records the optimization policy version separately from the casing codec version.
Optimize skips matching versions after checking the schema, complete text indexes,
and absence of history, without scanning rows or measuring directory size.
Structured datasets additionally require the expected helper mapping, supported
search policy, completed indexing, and a trusted manifest snapshot.
Older flat descriptors without this marker are recognized using those metadata
checks and upgraded atomically without rewriting the dataset. Structured datasets
without the current helper layout need a rewrite. Dry runs do not update JSON.
Changed Lance versions or optimization policies trigger a rewrite. Default-layout
fallbacks count as completed optimization too.

Copy or move the entire dataset directory, including the descriptor. Editing its
physical strings or patches with an unaware Lance client can invalidate the
representation. Quarry's `prep` decodes input before selection, renaming, simple
list flattening, and cleaning; objects and record lists retain their structure.
Version-3 resume checkpoints record storage/search policies and a logical digest.
Resume verifies logical values and helper contents before indexing and publication.
Older checkpoints are upgraded as needed. A failed build retains the checkpoint
and prints `./quarry prep --resume CHECKPOINT`; source inputs remain unchanged.

`quarry columns reorder` preserves logical values, casing companions, helper
mappings, and field encoding metadata. It rebuilds supported scalar indexes
with their existing names and columns before publishing the reordered dataset,
then refreshes version-2 completion and snapshot metadata. An indexing or
publication failure leaves the original recoverable.

C# continues to recognize deprecated `__lc` companions. This format does not change
the independently managed image-history index. External Lance readers see original
nested values and internal helpers, but do not reconstruct flat casing without
this codec. Copy the entire dataset directory, including `quarry-storage.json`.
