# SwarmUI Quarry

**Wildcards that can filter.** Use rich data files as SwarmUI wildcards and pick exactly the entries you want — right from your prompt.

A normal SwarmUI wildcard is a plain text file: one option per line, and `<wildcard:name>` picks a random line. Quarry lets you use **data files** instead — CSV, TSV, JSON, JSONL, Parquet, or [LanceDB](https://lancedb.com/) — where every entry can carry extra details in columns (prompt, tags, source, rating, and so on).

Because the entries have columns, you can **filter** them without leaving your prompt. Keep one big dataset and pull exactly what you want — "only punk tags," "only from this source," "anything but NSFW" — instead of maintaining dozens of separate `.txt` files.

## 📦 Ready-made datasets

Don't have data yet? A whole collection of prompt datasets — **already converted to LanceDB and ready to drop straight into Quarry** — lives here:

### → [huggingface.co/datasets/jtreminio/prompt-dataset](https://huggingface.co/datasets/jtreminio/prompt-dataset)

It's dozens of `*.lance` folders covering Stable Diffusion, Midjourney, Flux, Danbooru tags, photography, and more. Drop them in your Quarry datasets folder (see [Setup](#setup)) and they show up as wildcards right away — no conversion needed.

### Grab the whole collection (recommended)

Install the Hugging Face command-line tool, then download everything straight into your Quarry datasets folder — point `--local-dir` at it and every `*.lance` folder lands exactly where Quarry looks:

```bash
pip install -U huggingface_hub

hf download jtreminio/prompt-dataset --repo-type dataset \
  --local-dir /path/to/your/quarry-datasets
```

> Older Hugging Face installs use `huggingface-cli download` instead of `hf download` — the options are the same.

Prefer Git? You can clone the collection instead (needs [Git LFS](https://git-lfs.com)), then move the `*.lance` folders into your Quarry datasets folder:

```bash
git lfs install
git clone https://huggingface.co/datasets/jtreminio/prompt-dataset
```

### ...or just the datasets you want

To grab only some, add an `--include "<name>.lance/*"` line per dataset. Browse the [full list](https://huggingface.co/datasets/jtreminio/prompt-dataset/tree/main) on the dataset page to find their names:

```bash
hf download jtreminio/prompt-dataset --repo-type dataset \
  --include "Gustavosta.Stable-Diffusion-Prompts.lance/*" \
  --include "succinctly.midjourney-prompts.lance/*" \
  --local-dir /path/to/your/quarry-datasets
```

## How to use it

Drop a supported data file into your datasets folder (see [Setup](#setup)), then reference it anywhere in a prompt with Quarry's own `<q:...>` tag. (Pick datasets from the **Quarry** tab in the bottom bar — see [Setup](#setup).)

```
<q:NAME>                a random entry
<q:NAME[ FILTER ]>      a random entry that matches your filter
```

A filter is `column operator value`. List several values with commas — the operator decides how they match:

| Operator | Meaning | Example |
| --- | --- | --- |
| `=`  | matches **any** of the values | `tags=punk,goth` → punk *or* goth |
| `==` | matches **all** of the values | `tags==punk,goth` → punk *and* goth |
| `!=` | matches **none** of the values | `tags!=nsfw` → not nsfw |

Easy way to remember: **`=` one, `==` all, `!=` none.**

Stack filters with `;` to require all of them at once:

```
<q:prompts[tags=punk,goth ; source=civitai]>
```

### Examples

| Tag | What you get |
| --- | --- |
| `<q:prompts>` | any random prompt |
| `<q:prompts[tags=brunette,punk]>` | tagged brunette **or** punk |
| `<q:prompts[tags==brunette,punk]>` | tagged brunette **and** punk |
| `<q:prompts[tags!=nsfw]>` | **not** tagged nsfw |
| `<q:midjourney[prompt=girl]>` | prompts containing "girl" |
| `<q:prompts[tags=brunette,punk ; source=civitai]>` | (brunette or punk) **and** from civitai |
| `<q[3]:prompts[tags=punk]>` | 3 different punk prompts |

### Good to know

- **Matching is "contains," not exact.** `prompt=girl` finds every entry whose prompt *contains* "girl" — exact matching would defeat the point of a wildcard. Capitalization is ignored.
- Columns that hold a **list of tags** are matched tag-by-tag, but each tag is still "contains" — so `tags=girl` matches the tags `girls` and `young girl` (and, yes, `tags=punk` also matches `cyberpunk`). Plain text columns are matched by "contains" too.
- Values can include spaces (`long hair`), but these characters are reserved and can't appear inside a value: `; , = ! [ ] < >`
- Need several picks at once? SwarmUI's built-in count works: `<q[3]:prompts>` gives 3 different entries.

## Setup

1. Open the **Quarry** tab in SwarmUI's bottom bar (next to Wildcards).
2. Tick **Enable**, set the **Datasets folder** to a folder containing your data files, and click **Save**.
3. Each dataset shows a **prompt column** dropdown — pick the column that holds the prompt text (Quarry guesses sensibly, e.g. a column named `prompt`, `text`, or `caption`). Click **Save** again.
4. Use it in any prompt: `<q:prompts[tags=punk]>`.

The **Quarry** tab lists every dataset with its prompt column, tag columns, and row count. Click a dataset's **name** to drop a `<q:NAME>` reference into your prompt (click it again to remove it); datasets referenced by the current prompt are highlighted. Use **Preview** to peek at a dataset's first rows, and **Refresh** whenever you add or change files.

## Development

```bash
npm install
npm run build      # build the UI
./run-tests        # run the test suite
```

---

*Quarry reads your data with [DuckDB](https://duckdb.org/).*
