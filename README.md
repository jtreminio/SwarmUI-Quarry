# SwarmUI Quarry

**Wildcards, but they can filter.**

You know how a SwarmUI wildcard works: you make a text file, put one option per line, and `<wildcard:name>` grabs a random line. Simple and great. Quarry takes that idea and gives it a brain.

Instead of plain text files, Quarry reads **data files**: CSV, TSV, JSON, JSONL, Parquet, or [LanceDB](https://lancedb.com/). The difference is that every entry can carry extra info in columns, the prompt itself, tags, a source, a rating, whatever the file happens to have. Because those columns are there, you can **filter** right inside your prompt and pull exactly the entries you want. "Only punk." "Anything but nsfw." "Girls from this one source." One big dataset quietly does the job of a hundred little `.txt` files.

Here is the whole idea in two tags:

```
<q:characters>             a random entry from your "characters" dataset
<q:characters[tags=goth]>  a random entry that happens to be tagged goth
```

Neat, right? Let's take the tour.

## Where it lives: the Quarry tab

Everything happens in the **Quarry** tab down in SwarmUI's bottom bar, right next to Wildcards. Open it and you get a table of every dataset Quarry found, each with its prompt column, its tag columns, a row count, and a Preview button (more on all of those below).

The very first time you open the tab, Quarry will offer a one-time helper download (the DuckDB "lance" reader it uses to open datasets, around 235 MB). Click the button, give it a minute, and you are set. You only ever do this once.

## Getting started

1. Open the **Quarry** tab.
2. Quarry already made you a datasets folder, sitting right next to your Wildcards folder. Want it somewhere else? Type a new path in the **Datasets folder** box and click **Save Settings**.
3. Drop some data files into that folder (or grab ready-made ones with the Download button described below), then click **Refresh**.
4. Use them in any prompt: `<q:characters[tags=goth]>`.

That is genuinely it. There is no "enable" switch to hunt for; set a folder, or just keep the default, and Quarry is on.

## Ready-made datasets, one click away

No data of your own yet? No problem. There is a whole collection of prompt datasets, already converted and ready to drop straight in:

### [huggingface.co/datasets/jtreminio/prompt-dataset](https://huggingface.co/datasets/jtreminio/prompt-dataset)

Dozens of sets covering Stable Diffusion, Midjourney, Flux, Danbooru tags, photography, and more.

**The easy way:** in the Quarry tab, click **Download Datasets**. A window lists every dataset in the collection with its size. Click **Download** next to any one and it streams straight into your datasets folder with a live progress bar. Ones you already have are highlighted with a green check and get a **Redownload** button instead (handy when a set has been updated). One download runs at a time, and you can cancel partway through.

It will use your [Hugging Face token](https://huggingface.co/settings/tokens) if you have set one (under the User tab), but this collection is public, so it works perfectly well without one.

**Prefer the command line?** Install the Hugging Face tool and pull the whole collection into your datasets folder in one go:

```bash
pip install -U huggingface_hub

hf download jtreminio/prompt-dataset --repo-type dataset \
  --local-dir /path/to/your/quarry-datasets
```

Only want a few? Add an `--include "<name>.lance/*"` line per dataset (the names are listed on the [dataset page](https://huggingface.co/datasets/jtreminio/prompt-dataset/tree/main)):

```bash
hf download jtreminio/prompt-dataset --repo-type dataset \
  --include "Gustavosta.Stable-Diffusion-Prompts.lance/*" \
  --include "succinctly.midjourney-prompts.lance/*" \
  --local-dir /path/to/your/quarry-datasets
```

## Writing `<q:>` tags

This is the fun part. A Quarry tag always begins with `<q:` followed by the name of a dataset, and it grows from there as you need it:

```
<q:characters>                       one random entry from "characters"
<q:characters,creatures>             one random entry from either set
<q:*>                                one random entry from ALL your datasets
<q:portraits-*>                      one random entry from any "portraits-..." set
<q:characters[tags=girl]>            a random entry tagged "girl"
<q:characters,creatures[tags=girl]>  the same filter, across both sets
<q:*[tags=girl]>                     the same filter, across every set
```

Let's unpack that line by line.

### One dataset: `<q:FOO>`

The basics. `<q:characters>` rolls the dice and drops one random entry from the `characters` dataset into your prompt. Same spirit as a plain wildcard, just reading from a richer file.

### Several datasets at once: `<q:FOO,BAR>`

List more than one name, separated by commas, and Quarry treats them as a single combined pool, then picks one random entry from the whole thing. `<q:characters,creatures>` might hand you a character or a creature. (The bigger a dataset, the more of that pool it makes up, so it gets picked proportionally more often.)

### Everything, or part of it: `<q:*>` and `<q:name*>`

The `*` is a wildcard for your wildcards. On its own, `<q:*>` stands for **all** your datasets at once and picks a random entry from your whole collection.

It also matches **partial names**, which is perfect when you keep a family of related sets. Say you have `portraits-photo`, `portraits-anime`, and `portraits-vintage`: then `<q:portraits-*>` pulls from all three at once. The `*` can stand in for as much of the name as you like, so even `<q:por*>` would catch the lot. And partial names take filters just like everything else, so `<q:portraits-*[tags=girl]>` grabs a "girl" entry from every one of your portrait sets.

### Filtering: `<q:FOO[tags=girl]>`

Add `[ ... ]` after the name to filter. `<q:characters[tags=girl]>` keeps only the entries tagged "girl," then picks one of those at random. A filter reads as `column operator value`: which column to look in, how to match, and what to match.

### Filtering across many: `<q:FOO,BAR[tags=girl]>` and `<q:*[tags=girl]>`

A filter applies to **every** dataset in the tag. `<q:characters,creatures[tags=girl]>` keeps the "girl"-tagged entries from both sets, combines them, and picks one. And `<q:*[tags=girl]>` does the same thing across your whole collection: every dataset, filtered, pooled together, one pick.

> Heads up on `<q:*[ ... ]>`: the very first time you use a particular filter across all datasets, Quarry has to look through each one to see what matches, so it can take a moment to warm up. It remembers the answer for each dataset, though, so the next time you use that same filter it is quick. (And if some datasets do not have the column you asked for, Quarry simply skips those and uses the ones that do, so a wildcard query never breaks.)

### The three operators: `=`, `==`, `!=`

When you list several values, the operator decides how they have to match:

| Operator | Meaning | Example |
| --- | --- | --- |
| `=`  | match **any** of them  | `tags=punk,goth` keeps punk or goth |
| `==` | match **all** of them  | `tags==punk,goth` keeps punk and goth |
| `!=` | match **none** of them | `tags!=nsfw` drops anything nsfw |

Easy way to remember: **`=` one, `==` all, `!=` none.**

Want more than one condition? Stack filters with a semicolon and Quarry requires all of them at once:

```
<q:characters[tags=punk,goth ; source=civitai]>
```

That reads as "(punk or goth) and from civitai."

### A few examples

| Tag | What you get |
| --- | --- |
| `<q:prompts>` | any random prompt |
| `<q:prompts[tags=brunette,punk]>` | tagged brunette or punk |
| `<q:prompts[tags==brunette,punk]>` | tagged brunette and punk |
| `<q:prompts[tags!=nsfw]>` | not tagged nsfw |
| `<q:midjourney[prompt=girl]>` | prompts containing "girl" |
| `<q:*[tags=cyberpunk]>` | a cyberpunk entry from anywhere |
| `<q:portraits-*[tags=girl]>` | a "girl" from any of your `portraits-*` sets |
| `<q[3]:prompts[tags=punk]>` | 3 different punk prompts |

## Build tags by clicking

You never have to type any of this by hand if you would rather not. In the Quarry tab, **click a dataset's name** and Quarry drops a `<q:NAME>` reference straight into your prompt at the cursor. Click that same name again and it pops back out. Datasets your current prompt is using get highlighted in the table, so you can always see what is in play.

### "Add to existing `<q:>` tag"

There is a small checkbox in the tab: **Add to existing `<q:>` tag**, and it is **on by default**. While it is on, clicking a dataset name **adds it to the first `<q:...>` tag you already have**, so clicking "creatures" while `<q:characters>` is sitting in your prompt turns it into `<q:characters,creatures>`. It is the quickest way to build up a combined pull without wrangling brackets yourself. Prefer a separate tag every time? Switch it off, and each click inserts its own.

## Columns: prompt and tags

Each dataset row in the tab has two column settings, and Quarry fills both in with sensible guesses, so most of the time you can leave them alone.

### The prompt column

This is the column whose text actually lands in your prompt. Quarry guesses it by looking for an obvious name like `prompt`, `text`, `caption`, `description`, or `value`, and if none of those exist it just uses the first column in the file. Guessed wrong? Pick the right one from the dropdown and click **Save Settings**.

### The tag columns

These are the columns the `tags=` keyword searches. Tick whichever columns hold tags (a dataset can have several, and Quarry searches every one you tick). Here is the friendly part: **if you do not set any tag columns at all, `tags=` just searches the prompt column instead.** So `<q:something[tags=girl]>` still does something useful on every dataset, even a bare one that has nothing but a prompt.

## Peek inside: the Preview button

Not sure what is in a dataset, or which column is which? Hit **Preview** on its row. A pop-up shows the first rows of the dataset in a plain table with every column on display, so you can eyeball the real data, spot which column holds the prompt, and see what your tag columns actually look like. Need more? **Load 500 more** pulls the next chunk. There is also a **Clear cache** button for when you have changed a file and want a fresh look.

## Good to know

- **Matching is "contains," not exact.** `prompt=girl` finds every entry whose prompt *contains* "girl" (exact matching would rather defeat the point of a wildcard). Capitalization does not matter.
- Tag columns are matched tag by tag, but each tag is still "contains," so `tags=girl` also matches `girls` and `young girl` (and yes, `tags=punk` will match `cyberpunk` too).
- Values can include spaces (`long hair`), but these characters are reserved and cannot appear inside a value: `; , = ! [ ] < >`
- Need several picks from a single tag? SwarmUI's built-in count works: `<q[3]:characters>` gives you 3 different entries.

## Under the hood

Quarry reads your data with [DuckDB](https://duckdb.org/) and its [LanceDB](https://lancedb.com/) reader. Building from source:

```bash
npm install
npm run build      # build the UI
./run-tests        # run the test suite
```
