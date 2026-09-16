# Quarry casing storage v1

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
format 2.1. If optimization hits the miniblock size limit or its known native writer panic,
it retries with 1,024-row input batches, then with Lance's default layout if needed.
Each retry restarts the temporary dataset; casing and index guarantees are unchanged.
Binary patches use default encoding. All text fields get NGRAM indexes;
short and non-ASCII queries use scanning because the installed NGRAM tokenizer
cannot reliably answer them (for example, it returns no matches for a CJK-only
term). ASCII terms of three or more characters retain indexed filtering. Reconstruction happens only for returned
values, before Quarry's existing trimming/joining of prompt columns.

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

## Operations and compatibility

Migration writes a new sibling dataset, verifies all logical values and required
indexes, removes historical versions, then publishes it. A temporary original is
retained only through publication/rollback. A process or machine crash can leave
`.quarry-optimize-*` work directories; if publication was interrupted, the original
may be at `original.lance` inside that directory. Do not remove it until recovery.
There is no concurrent reader/writer guarantee during directory replacement.

Completed optimization and prep also write an `optimized` object to the descriptor:
`{"version":1,"lance_version":3}` (the Lance version varies per dataset).
This records the optimization policy version separately from the casing codec version.
Optimize skips matching versions after checking the schema, complete text indexes,
and absence of history, without scanning rows or measuring directory size.
Older descriptors without this marker are recognized using those metadata checks
and upgraded atomically without rewriting the dataset. Dry runs do not update JSON.
Changed Lance versions or optimization policies trigger a rewrite. Default-layout
fallbacks count as completed optimization too.

Copy or move the entire dataset directory, including the descriptor. Editing its
physical strings or patches with an unaware Lance client can invalidate the
representation. Quarry's `prep` decodes input before selection, renaming, flattening,
and cleaning; its resume checkpoint version 2 requires the descriptor. Legacy
version 1 checkpoints are upgraded once before publication.

`quarry columns reorder` preserves the descriptor byte-for-byte, all casing
companions, and field encoding metadata. It rebuilds supported scalar indexes
with their existing names and columns before publishing the reordered dataset.
An indexing or publication failure leaves the original recoverable.

C# continues to recognize deprecated `__lc` companions. This format does not change
the independently managed image-history index. No external Lance reader will
reconstruct casing automatically without this codec.
