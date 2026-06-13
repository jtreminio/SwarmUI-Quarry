# SwarmUI Quarry

**Wildcards that can filter.** Use rich data files as SwarmUI wildcards and pick exactly the entries you want — right from your prompt.

A normal SwarmUI wildcard is a plain text file: one option per line, and `<wildcard:name>` picks a random line. Quarry lets you use **data files** instead — CSV, TSV, JSON, JSONL, Parquet, or [LanceDB](https://lancedb.com/) — where every entry can carry extra details in columns (prompt, tags, source, rating, and so on).

Because the entries have columns, you can **filter** them without leaving your prompt. Keep one big dataset and pull exactly what you want — "only punk tags," "only from this source," "anything but NSFW" — instead of maintaining dozens of separate `.txt` files.

## 📦 Ready-made datasets

Don't have data yet? A whole collection of prompt datasets — **already converted to LanceDB and ready to drop straight into Quarry** — lives here:

### → [huggingface.co/datasets/jtreminio/prompt-dataset](https://huggingface.co/datasets/jtreminio/prompt-dataset)

It's dozens of `*.lance` folders covering Stable Diffusion, Midjourney, Flux, Danbooru tags, photography, and more. Grab the ones you want, drop them in your Quarry datasets folder (see [Setup](#setup)), and they show up as wildcards right away — no conversion needed.

### Grab just the datasets you want (recommended)

Install the Hugging Face command-line tool, then download individual folders with `--include`. Point `--local-dir` at your Quarry datasets folder so they land exactly where Quarry looks:

```bash
pip install -U huggingface_hub

hf download jtreminio/prompt-dataset --repo-type dataset \
  --include "Gustavosta.Stable-Diffusion-Prompts.lance/*" \
  --include "succinctly.midjourney-prompts.lance/*" \
  --local-dir /path/to/your/quarry-datasets
```

Add an `--include "<name>.lance/*"` line for each dataset you want. Browse the [full list](https://huggingface.co/datasets/jtreminio/prompt-dataset/tree/main) on the dataset page to find their names.

> Older Hugging Face installs use `huggingface-cli download` instead of `hf download` — the options are the same.

### ...or grab everything at once

Clone the whole collection with Git (needs [Git LFS](https://git-lfs.com) installed):

```bash
git lfs install
git clone https://huggingface.co/datasets/jtreminio/prompt-dataset
```

Then move the `*.lance` folders into your Quarry datasets folder. Heads up — this downloads **all** of them, which is large.

## How to use it

Drop a supported data file into your datasets folder (see [Setup](#setup)), then use it anywhere in a prompt. (`wc` is SwarmUI's shorthand for `wildcard`.)

```
<wc:NAME>                a random entry
<wc:NAME[ FILTER ]>      a random entry that matches your filter
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
<wc:prompts[tags=punk,goth ; source=civitai]>
```

### Examples

| Tag | What you get |
| --- | --- |
| `<wc:prompts>` | any random prompt |
| `<wc:prompts[tags=brunette,punk]>` | tagged brunette **or** punk |
| `<wc:prompts[tags==brunette,punk]>` | tagged brunette **and** punk |
| `<wc:prompts[tags!=nsfw]>` | **not** tagged nsfw |
| `<wc:midjourney[prompt=girl]>` | prompts containing "girl" |
| `<wc:prompts[tags=brunette,punk ; source=civitai]>` | (brunette or punk) **and** from civitai |
| `<wc[3]:prompts[tags=punk]>` | 3 different punk prompts |

### Good to know

- **Matching is "contains," not exact.** `prompt=girl` finds every entry whose prompt *contains* "girl" — exact matching would defeat the point of a wildcard. Capitalization is ignored.
- Columns that hold a **list of tags** are matched tag-by-tag (so `tags=punk` won't match "cyberpunk"); plain text columns are matched by "contains."
- Values can include spaces (`long hair`), but these characters are reserved and can't appear inside a value: `; , = ! [ ] < >`
- Need several picks at once? SwarmUI's built-in count works: `<wc[3]:prompts>` gives 3 different entries.

## Setup

1. Open the **Quarry** panel in SwarmUI's **Tools / Utilities** area.
2. Tick **Enable**, set the **Datasets folder** to a folder containing your data files, and click **Save**.
3. Each dataset shows a **prompt column** dropdown — pick the column that holds the prompt text (Quarry guesses sensibly, e.g. a column named `prompt`, `text`, or `caption`). Click **Save** again.
4. Use it in any prompt: `<wc:prompts[tags=punk]>`.

Your datasets also appear in SwarmUI's normal wildcard autocomplete, so typing `<wc:` suggests them just like built-in wildcards. Click **Refresh** whenever you add or change files.

## Development

```bash
npm install
npm run build      # build the UI
./run-tests        # run the test suite
```

---

*Quarry reads your data with [DuckDB](https://duckdb.org/).*
