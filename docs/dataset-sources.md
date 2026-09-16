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

Uploads preserve local names and subdirectories. They use the [Hugging Face SDK's upload helpers](https://huggingface.co/docs/huggingface_hub/guides/upload); rerunning resumes through its existing-file and content deduplication support. Keep dataset contents stable during upload. Sync does not rename local datasets; use Quarry's startup/refresh migration first if the directory still contains legacy names.

After **all uploads succeed**, the command checks only dataset names not already registered (including aliases):

1. Infer `org/repo` from `category/org.repo` or `category/org.repo.subset`.
2. Check that Hugging Face can resolve that dataset repository. A successful check records its URL automatically.
3. Ask for the origin URL of each unresolved dataset, after all automatic checks. A manually supplied full HTTP(S) URL is an explicit attribution override and can point outside Hugging Face.
4. Enter `NONE` (case-insensitive) to record `sourceUrl: null`.

Each automatic result and prompt answer is saved atomically as it is recorded. Interrupting prompts keeps completed answers and leaves unanswered datasets absent from the catalog, so the next run asks again. `--no-input` saves automatically verified origins and exits with status 2 if any names still need answers. An upload failure skips pruning and source recording; rerun the command to finish. Other errors return status 1.

`--prune` deletes whole remote datasets that have no matching local path, after uploads succeed. It preserves the README, `.gitattributes`, the source catalog, and hidden trees. It does not remove old files or Lance versions inside datasets that remain locally, and it does not remove source records. A remote commit change between the deletion plan and its commit causes pruning to fail rather than silently applying a stale plan. Without `--prune`, no remote datasets are deleted.

`--dry-run` prints upload candidates, any proposed deletions, and newly discovered source names without uploading, deleting, editing JSON, or prompting. `--catalog /path/to/sources.json` overrides the default checked-in file, whose location is anchored to this extension rather than the current working directory.

The JSON is embedded/bundled into the extension. After changing it, run `npm run build`, review its diff, and include it with the extension update. Rebuild/restart SwarmUI to load backend catalog changes. Sync does not commit changes to this Git repository.

## Rename behavior

- Startup and refresh rename installed datasets. Lance directories and supported single-file formats retain their contents and format.
- Missing datasets are skipped, and later installations are checked again.
- Existing destination datasets are preserved, including destinations using a different format. A collision leaves both copies in place and logs a warning. Exact old names still select the old copy in that case.
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
