# Storage fixtures

`casing-v1.json` is the shared Python/C# casing codec contract.

`lance-v22.zip` contains a Python-generated `sample.lance` dataset and its original
logical values in `expected.json`. It exercises format 2.2 miniblocks through the
real C# DuckDB reader, including long strings, Unicode, nulls, casing restoration,
and NGRAM indexes. Python tests also use those values to exercise optimize, prep,
and column reordering.

It was written with `pylance==7.0.0`, `duckdb==1.5.3`, Quarry's
`storage.encoded_reader`, and `lance.write_dataset(data_storage_version="2.2")`.
Both logical columns have NGRAM indexes; historical versions were cleaned before
archiving the whole dataset with its `quarry-storage.json` descriptor.

The two long strings are successive 60,000-character draws from
`random.Random(4614).choices(string.ascii_letters + string.digits + " ", k=60000)`.
The archive's `expected.json` retains the exact input needed to regenerate it.
