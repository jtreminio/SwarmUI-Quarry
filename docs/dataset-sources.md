# Dataset sources and legacy names

The shared `dataset-sources.json` catalog is embedded in the backend and bundled into the download dialog. Each entry records a dataset’s `name`, `sourceUrl`, and nullable `alias` string for its previous name.

An entry with `sourceUrl: null`, `sourceUrl: ""`, or no `sourceUrl` explicitly has no source link. It is never inferred or prompted for again. A dataset absent from the catalog can still use the normal `org.repo` link convention until it is registered. The sync command retains old catalog entries and aliases even when datasets are pruned from the remote collection, preserving attribution and prompt compatibility.

## Publishing a local collection

Run from the extension directory:

```bash
./quarry hf sync /path/to/Quarry --dry-run
./quarry hf sync /path/to/Quarry
./quarry hf sync /path/to/Quarry --prune --dry-run
./quarry hf sync /path/to/Quarry --prune
```

The default target is the existing Hugging Face dataset repository `jtreminio/prompt-dataset`, branch `main`. Override it with `--repo owner/collection` and optionally `--revision branch`. Authentication uses `HF_TOKEN`, then `HUGGINGFACE_HUB_TOKEN`, then the SDK's saved login. This command publishes data, so choose the directory containing the collection you intend to upload.

The command discovers Lance dataset directories and supported CSV, TSV, JSON, JSONL, NDJSON, and Parquet files recursively. It ignores hidden category directories, including `.image-history`, `.cache`, and incomplete download staging directories, as well as the selected catalog file. Lance internal files, such as `_versions` and `_indices`, stay with their dataset. The local directory must contain at least one dataset. Symlinks, empty Lance directories, and multiple local formats using the same dataset name are rejected before uploading.

You can also pass a single `.lance` directory, with or without a trailing slash. For example, `./quarry hf sync /path/to/Quarry/tags/jgreely.c1ga.lance/` uploads that entire dataset to `jgreely.c1ga.lance/` at the repository root and records the source name `jgreely.c1ga`. To preserve the `tags/` prefix, sync the parent collection `/path/to/Quarry` instead. `--prune` still compares against the entire remote collection, so use it only when the input represents the complete collection you want to keep.

Uploads preserve local names and subdirectories. Each Lance dataset is published with one Hugging Face commit containing its complete local file set and deletions of obsolete remote files inside that dataset. This keeps manifests, data, indexes, and storage metadata consistent for readers. The local copy is authoritative: files absent locally are removed remotely even without `--prune`. Other dataset directories and repository metadata are untouched. The commit checks its expected parent, so a concurrent remote change stops publication instead of applying a stale deletion plan. The SDK still deduplicates unchanged file contents. Keep dataset contents stable during upload. Sync does not rename local datasets; use Quarry's startup/refresh migration first if the directory still contains legacy names.

Sync hashes Lance datasets with up to **8 workers** in parallel, then compares each hash with `datasetHash` in the remote dataset's `quarry-storage.json` and compares the complete published file list with the local file list. Set `--hash-workers N` to change concurrency, or `--hash-workers 1` for serial hashing. Only matching hashes **and file sets** print `Skip [UNCHANGED]` and bypass publication. Matching hashes with extra or missing remote files print `Repair [FILE SET]` and trigger an upload. New datasets, different hashes, and missing or invalid remote hashes also trigger uploads. The remote file list and small descriptors are read from the repository commit captured at the start of sync; dataset contents are not downloaded. Remote lookup failures stop sync. Single-file datasets continue through the SDK's normal upload path. The summary reports uploaded, skipped, and obsolete-file counts; skipped datasets still participate in source recording and are kept during pruning.

After **all uploads succeed**, the command checks only dataset names not already registered (including aliases):

1. Infer `org/repo` from `category/org.repo` or `category/org.repo.subset`.
2. Check that Hugging Face can resolve that dataset repository. A successful check records its URL automatically.
3. Ask for the origin URL of each unresolved dataset, after all automatic checks. A manually supplied full HTTP(S) URL is an explicit attribution override and can point outside Hugging Face.
4. Enter `NONE` (case-insensitive) to record `sourceUrl: null`.

Each automatic result and prompt answer is saved atomically as it is recorded. Interrupting prompts keeps completed answers and leaves unanswered datasets absent from the catalog, so the next run asks again. `--no-input` saves automatically verified origins and exits with status 2 if any names still need answers. An upload failure skips pruning and source recording; rerun the command to finish. Other errors return status 1.

`--prune` additionally deletes whole remote datasets that have no matching local path, after uploads succeed. It preserves the README, `.gitattributes`, the source catalog, and hidden trees. Cleanup inside uploaded datasets happens independently of this flag. Pruning does not remove source records. A remote commit change between the deletion plan and its commit causes pruning to fail rather than silently applying a stale plan. Without `--prune`, remote datasets absent locally are kept.

`--dry-run` performs the same hash and file-set comparisons without writing local hashes, labels matching datasets `Skip [UNCHANGED]`, and labels upload candidates `[NEW]` when their destination path is absent from HF or `[EXISTING]` when it is already present. It prints remote presence totals, upload/skip counts, and every obsolete file that publication would remove. This checks the remote repository independently of the source catalog and works with or without `--prune`. It also prints proposed whole-dataset deletions and newly discovered source names without uploading, deleting, editing dataset or catalog JSON, or prompting. Remote descriptors may be downloaded to the SDK cache. `--catalog /path/to/sources.json` overrides the default checked-in file, whose location is anchored to this extension rather than the current working directory.

### Repairing mixed published Lance versions

Earlier uploads could leave old manifests, data, and indexes on HF after a local rebuild. Lance chooses the highest version number, so an old version 11 could override the rebuilt version 2 while the new descriptor expects different casing columns. This causes `Invalid casing columns for 'prompt'` on fresh downloads.

Run the dry run above against your maintained, working local collection and inspect the `Repair [FILE SET]` and `Remove obsolete file` lines. Then run the same sync without `--dry-run`. No version bump or `--prune` is needed. Do not use an already-broken download as the authoritative local copy: sync mirrors its files, including any stale manifests still present locally. Repairing remote-only leftovers can leave the published hash unchanged, so an update badge is not guaranteed.

### Repairing existing downloads without downloading them again

In Quarry, open **Download Datasets** and click **Repair datasets** next to **Refresh**. This checks the saved datasets folder for mixed Quarry casing snapshots and uses the version already recorded in each dataset's metadata. The repair itself works without contacting Hugging Face and does not copy or download the large data files.

Readable datasets are left alone. For a broken dataset with a known local snapshot, repair moves conflicting manifests and the old version hint into a hidden `.quarry-repair-*` folder inside that dataset. It then checks schema, row count, and a small preview using a fresh reader. These checks target the stale-version casing error; they do not scan every row for unrelated corruption. If verification fails, the original metadata is restored and the result identifies the affected dataset. Missing or ambiguous versions are not guessed. Metadata backups are retained; old data/index files are not deleted by this repair.

The dataset list refreshes after the repair. Downloads and another repair cannot run at the same time, and Quarry's active readers finish before metadata changes. Repair requires the same installation permission as dataset downloads. If the recorded snapshot or its data is absent or damaged, the result may require a fresh download.

The JSON is embedded/bundled into the extension. After changing it, run `npm run build`, review its diff, and include it with the extension update. Rebuild/restart SwarmUI to load backend catalog changes. Sync does not commit changes to this Git repository.

## Dataset updates

The download dialog shows **Update available!** when an installed dataset's `datasetHash` differs from the published hash in `quarry-storage.json`, or when its local descriptor/hash is missing. **Select updates** selects those datasets, including ones in collapsed folders. Opening the dialog uses a five-minute listing cache; **Refresh** checks Hugging Face again. A remote descriptor without a published hash cannot advertise updates yet.

`hf sync` recalculates each Lance dataset's hash from its current contents before comparing with HF, so a stale local `datasetHash` cannot hide edits. Normal runs write the hash into the existing storage descriptor. The hash covers relative file names, file contents, and storage metadata, excluding the hash field itself and hidden local files. A dataset without a descriptor receives a valid descriptor with an empty column mapping. Renaming the dataset directory does not change the hash. Dry runs hash without modifying datasets. Keep contents stable during sync; rerun sync after modifying a published dataset.

Clients compare only the small JSON descriptors and do not scan or hash installed data. Downloads use a fixed repository commit and include that commit's descriptor. No hashes or version numbers are displayed. To enable updates for existing installations, publish the collection through `hf sync`; older local copies then receive the update badge without needing a preliminary download.

## Rename behavior

- Startup and refresh rename installed datasets. Lance directories and supported single-file formats retain their contents and format.
- Missing datasets are skipped, and later installations are checked again.
- If the corrected dataset already exists, it is preserved and the legacy copy is deleted, including when the copies use different formats. Failed deletions are logged and retried on the next startup or refresh.
- Old exact query names resolve to the corrected name, including names without a category prefix. The compatibility mapping does not rewrite arbitrary glob patterns.
- Column preferences and disabled state use the corrected names; existing preferences under the corrected name take priority.
- Remote paths remain separate from local names, so downloads work before and after the collection is renamed. If both remote spellings exist, the corrected one is preferred.

## Dataset mappings

[dataset-sources.json](../dataset-sources.json) contains the canonical names, legacy aliases, and origin URLs. File and subset suffixes distinguish datasets from the same source repository.

The split names were checked against original repository files:

- [Chat-Error/tinystories-gpt4](https://huggingface.co/datasets/Chat-Error/tinystories-gpt4/tree/main) contains `eval.parquet` and `train.parquet`.
- [SicariusSicariiStuff/Short_Stories_ShareGPT](https://huggingface.co/datasets/SicariusSicariiStuff/Short_Stories_ShareGPT/tree/main) contains `Short_Stories_ShareGPT1.json`; the trailing `1` belongs to that file, not the repository name.
- [roneneldan/TinyStories](https://huggingface.co/datasets/roneneldan/TinyStories/tree/main) contains `TinyStoriesV2-GPT4-train.txt`.
- The `scenario` and `user_description` variants retain separate names under [agentlans/lemonilia-LimaRP](https://huggingface.co/datasets/agentlans/lemonilia-LimaRP).

## Attribution exceptions

- `nl/jgreely.c1ga` credits [jgreely/c1ga on GitHub](https://github.com/jgreely/c1ga).
- `tags/CyberHarem` remains an aggregate dataset and credits [CyberHarem](https://huggingface.co/CyberHarem).
- [CaptionEmporium/laion-pop-llama3.2-11b](https://huggingface.co/datasets/CaptionEmporium/laion-pop-llama3.2-11b) and [RicemanT/Anime-Background-Finetuning-V1.1](https://huggingface.co/datasets/RicemanT/Anime-Background-Finetuning-V1.1) have literal dots in their repository names. Explicit attribution avoids mistaking those dots for subset separators; their local dataset names remain unchanged.
