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

If Quarry asks to install its dataset reader, click the install button and wait for it to finish. You only need to do this once.

## Getting started

1. Open the **Quarry** tab.
2. Quarry already made you a datasets folder, sitting right next to your Wildcards folder. Want it somewhere else? Type a new path in the **Datasets folder** box and click **Save Settings**.
3. Drop some data files into that folder (or grab ready-made ones with the Download button described below), then click **Refresh**.
4. Use them in any prompt: `<q:characters[tags=goth]>`.

That is it. There is no "enable" switch to hunt for; set a folder, or just keep the default, and Quarry is on.

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

## Prepare your own dataset with one command

From this extension's directory, use the `quarry` CLI (requires [uv](https://docs.astral.sh/uv/)):

```bash
./quarry prep /path/to/data.parquet
```

Quarry prints the source row count and available columns, then asks which to keep. Enter column names in the order you want, separated by semicolons. Rename any column with `original_name=new_name`; a bare name keeps its existing name:

```text
Columns to keep: caption=prompt;tags;rating=score
```

This keeps only those three columns, in that order. Quarry converts the selection to Lance, flattens simple value lists into text, removes empty and duplicate prompt rows, and builds search indices automatically. Direct objects and arrays of direct objects keep their structure so you can query their fields and select records at runtime.

Inputs can be CSV, TSV, JSON, JSONL, NDJSON, Parquet, or a `.lance` dataset directory. The result is `<stem>.lance` beside the input, or `<stem>.prepared.lance` for Lance input. The source stays intact, and an existing output is never overwritten. Use `-o` to choose an output path, or `--columns` to supply the selection without a prompt:

```bash
./quarry prep data.jsonl -o /path/to/Quarry/prompts.lance \
  --columns 'caption=prompt;tags;rating=score'
```

Cleaning uses the first selected column named `prompt`, `text`, `caption`, `description`, or `value` in that preference order, falling back to the first selected column. Use `--prompt-column` with its **new name** to override this. Run `./quarry prep --help` for all options; the existing individual commands remain available.

For a JSONL file whose structured column is already named `prompt`:

```bash
./quarry prep ~/data/AIConfigs/OriginalDatadumps/original.jsonl --columns 'prompt'
```

If that column is named `subject`, rename it during preparation:

```bash
./quarry prep portraits.jsonl --columns 'subject=prompt;style;setting'
```

The resulting `prompt` stays a native object or list of objects. The default tag prints all records, and preparation retains every record. Duplicate detection compares **all records in order**, normalizing each text value by lowercasing and removing non-alphanumeric characters. Field names, scalar types, nulls, value boundaries, and repeated records remain significant: `[A, B]` differs from `[A, C]`, `[B, A]`, and `[A]`. Equivalent complete prompts keep the earliest source row and its original values. A blank first record does not discard a populated later record. Wholly punctuation-only prompts retain the existing exception from deduplication.

Quarry discovers JSON fields across the entire input before reading with explicit types. Date-shaped strings stay strings, and integers retain their exact supported signed or unsigned 64-bit values. Mixed scalar kinds within one field, out-of-range numbers, deeper nesting, and ambiguous field names produce an error identifying the field. Fix the input instead of relying on automatic conversion to strings or floating-point numbers. Field output order follows the unified schema's first-seen field order; record order follows the source array.

## Writing `<q:>` tags

This is the fun part. A Quarry tag always begins with `<q:` followed by the name of a dataset, and it grows from there as you need it:

```
<q:characters>                       one random entry from "characters"
<q:characters,creatures>             one random entry from either set
<q:*>                                one random entry from your top-level datasets
<q:**>                               like <q:*>, but reaches into subfolders too
<q:portraits-*>                      one random entry from any "portraits-..." set
<q:characters[tags=girl]>            a random entry tagged "girl"
<q:characters,creatures[tags=girl]>  the same filter, across both sets
<q:*[tags=girl]>                     the same filter, across your top-level sets
<q:characters:caption>               read the prompt from the "caption" column
<q:characters:appearance,clothing>   print both columns from the same random row
```

Let's unpack that line by line.

### One dataset: `<q:FOO>`

The basics. `<q:characters>` rolls the dice and drops one random entry from the `characters` dataset into your prompt. Same spirit as a plain wildcard, just reading from a richer file.

### Several datasets at once: `<q:FOO,BAR>`

List more than one name, separated by commas, and Quarry treats them as a single combined pool, then picks one random entry from the whole thing. `<q:characters,creatures>` might hand you a character or a creature. (The bigger a dataset, the more of that pool it makes up, so it gets picked proportionally more often.)

### Everything, or part of it: `<q:*>`, `<q:**>`, and `<q:name*>`

The `*` is a wildcard for your wildcards. On its own, `<q:*>` stands for **all your top-level datasets** at once and picks a random entry from them.

If you keep some datasets in subfolders, a single `*` stays at **one level**: `<q:*>` covers the datasets sitting loose in your datasets folder, and `<q:anime/*>` covers the ones directly inside `anime`. Use a **double** star to **recurse** — `<q:**>` reaches every dataset no matter how deeply nested, and `<q:anime/**>` reaches everything under `anime`. (No subfolders? Then `*` and `**` mean the same thing: everything.)

It also matches **partial names**, which is perfect when you keep a family of related sets. Say you have `portraits-photo`, `portraits-anime`, and `portraits-vintage`: then `<q:portraits-*>` pulls from all three at once. The `*` can stand in for as much of the name as you like, so even `<q:por*>` would catch the lot. And partial names take filters just like everything else, so `<q:portraits-*[tags=girl]>` grabs a "girl" entry from every one of your portrait sets.

### Objects and arrays of records

Quarry supports objects containing scalar fields and arrays of those objects. For example:

```json
{"style":"Photo","subject":[{"hair":"blond","eyes":"blue"},{"hair":"red","eyes":"green"}]}
```

You can use the JSONL directly or preserve these columns with `quarry prep`. Objects with nested objects or arrays, and arrays of arrays, are unsupported. Simple lists of text remain supported. JSON stored inside a string stays a string; nested selectors require native object/list columns.

| Selector | Meaning |
| --- | --- |
| `subject` / `subject[]` | Search any record; print all records in array order |
| `subject.hair` / `subject[].hair` | Search any record's `hair` field; print all `hair` values |
| `subject[0]` / `subject[1]` | First / second record (zero-based) |
| `subject[i]` | A record bound to variable `i` by a filter |
| `meta` / `meta.style` | A direct object's values / one field |

Bare arrays and `[]` are equivalent. Use `[0]` to select only the first record.
With `+=` / `-=`, bare arrays and `[]` compare the non-null record count.
A direct object needs no array selector. Existing queries that relied on a bare
array selecting the first record must now use `[0]` explicitly.

For example, after naming your subject array `prompt`, find rows with at least two
subjects and print all of them:

```text
<q:nl/jgreely.c1ga[prompt+=2]:prompt>
```

Use `prompt-=2` for at most two, or `prompt+=2;prompt-=2` for exactly two.
Null slots are excluded; null and empty arrays count as zero. An object whose
fields are all blank still counts as a record. Counts do not change output
selection: `:prompt` prints all records, while `:prompt[0]` prints only record zero.

```text
<q:portraits[subject[i].hair=blond;subject[i].eyes=blue]:subject[i]>
<q:portraits[subject[i].hair=blond;subject[i].eyes=blue]:subject[]>
<q:portraits[subject[i].hair=blond;subject[i].eyes=blue;subject[n].hair=red;subject[n].eyes=green]:subject[i],subject[n]>
```

Semicolons mean AND. Repeated variables must match the same record. Different variables in the same array automatically require distinct records; variables are scoped to their array column. Quarry selects the first complete valid assignment in variable appearance and array order, trying later candidates when necessary. Output variables must be bound by a filter. The first example prints the matching subject, the second prints all subjects, and the third prints the two distinct matching subjects in the specified order.

Each source row counts once, regardless of how many assignments match. Selecting multiple subjects does not give that row extra weight during random selection.

Unbound array conditions are independent: `subject[].hair=blond;subject[].eyes=blue` can match hair and eyes from different subjects. Use a shared variable to require the same subject. `subject[].hair==blond,red` requires both terms somewhere among the selected values, while `subject[].hair!=blond,red` requires neither term anywhere. As with flat text columns, matches are case-insensitive substrings. Numeric and text-length comparisons require an individual nested field, such as `subject[0].age+=18` or `subject[i].age+=18`; `subject.age+=18` and `subject[].age+=18` are not supported. Whole-array comparisons count records instead.

Missing indices, nulls, and empty values produce no text or separators. Unknown fields, unbound variables, and invalid selectors produce query errors rather than falling back to the default prompt column. Rows whose nested output is entirely empty are excluded from the eligible count. A negative nested condition matches when no selected value contains its terms, including when the selected value is absent.

### Field names and output separators

Add output options after `|`:

```text
<q:portraits[subject[i].hair=blond; subject[i].eyes=blue; subject[n].hair=red; subject[n].eyes=green]:subject[i], subject[n]|keys; record_separator=" = "; field_separator=", ">
```

Output:

```text
hair: blond, eyes: blue = hair: red, eyes: green
```

| Option | Behavior | Default |
| --- | --- | --- |
| `keys` | Prefix nonempty values with their literal field names and `: ` | Off |
| `record_separator` or `rs` | Join records and separately selected outputs | `", "` |
| `field_separator` or `fs` | Join fields within each record | `", "` |

Options apply to the whole output selection. Separators are double-quoted strings; spaces are preserved, and JSON escapes such as `\n` and `\"` are accepted. Quoted semicolons, commas, brackets, and pipes are literal separator text. To include angle brackets in a tag separator, use `\u003c` and `\u003e` so they do not close SwarmUI's tag early. Duplicate options (including a long name and its alias) are rejected.

```text
<q:portraits:subject[]|keys>
<q:portraits:subject[]|keys;rs="; ";fs=", ">
```

### Leaving a dataset out of wildcards

Every dataset in the Quarry tab has a little on/off switch next to it. Flip it **off** and that dataset is skipped whenever a wildcard would otherwise sweep it in — `<q:*>`, `<q:**>`, `<q:anime/**>`, `<q:por*>`, and so on all pretend it isn't there. Handy for a set you keep around but don't want mixed into "everything" rolls.

The switch only affects wildcard matches. **Name the dataset directly and it still works**, even while switched off: `<q:portraits-vintage[tags=girl]>` reads `portraits-vintage` no matter what its toggle says. So "off" means "don't pull me in automatically," not "disabled." The switch saves the moment you click it — no need to press **Save Settings**.

### Filtering: `<q:FOO[tags=girl]>`

Add `[ ... ]` after the name to filter. `<q:characters[tags=girl]>` keeps only the entries tagged "girl," then picks one of those at random. A filter reads as `column operator value`: which column to look in, how to match, and what to match.

### Filtering across many: `<q:FOO,BAR[tags=girl]>` and `<q:*[tags=girl]>`

A filter applies to **every** dataset in the tag. `<q:characters,creatures[tags=girl]>` keeps the "girl"-tagged entries from both sets, combines them, and picks one. And `<q:*[tags=girl]>` does the same thing across your top-level datasets — each one, filtered, pooled together, one pick — while `<q:**[tags=girl]>` widens that to every dataset in every subfolder.

> Heads up on `<q:*[ ... ]>`: the very first time you use a particular filter across all datasets, Quarry has to look through each one to see what matches, so it can take a moment to warm up. It remembers the answer for each dataset, though, so the next time you use that same filter it is quick. (And if some datasets do not have the column you asked for, Quarry simply skips those and uses the ones that do, so a wildcard query never breaks.)

### The operators: `=`, `==`, `!=`, `+=`, `-=`

When you list several values, the operator decides how they have to match:

| Operator | Meaning | Example |
| --- | --- | --- |
| `=`  | match **any** of them  | `tags=punk,goth` keeps punk or goth |
| `==` | match **all** of them  | `tags==punk,goth` keeps punk and goth |
| `!=` | match **none** of them | `tags!=nsfw` drops anything nsfw |
| `+=` | number, text length, or array count is **at least** | `prompt+=2` keeps arrays with two or more non-null records |
| `-=` | number, text length, or array count is **at most** | `prompt-=2` keeps arrays with at most two non-null records |

Easy way to remember: **`=` one, `==` all, `!=` none**, and **`+=` up, `-=` down** — the number itself, the text's character count, or the array's non-null element count.

The last two, `+=` (at least) and `-=` (at most), compare **number columns** directly (a rating, a width, a year). On a **text column**, they compare its length in characters instead: `prompt+=100` means at least 100 characters, while `prompt-=500` means at most 500. On an **array column**, they count non-null elements (records or scalar values). For the merged `tags` keyword, each configured column is compared separately and any matching column qualifies; their lengths/counts are not added together.

Want more than one condition? Stack filters with a semicolon and Quarry requires all of them at once:

```
<q:characters[tags=punk,goth ; source=civitai]>
```

That reads as "(punk or goth) and from civitai."

### Picking the prompt column: `<q:FOO:BAR>`

Every dataset has a **prompt column** — the column whose text actually lands in your prompt (Quarry guesses a sensible default, see [The prompt column](#the-prompt-column) below). Add `:column` to the **end** of a tag to read from a different column just for that tag:

```
<q:characters:caption>             read each entry's "caption" column instead of the default
<q:characters[tags=girl]:caption>  same, but only "girl"-tagged entries — the column goes after the filter
<q:characters,creatures:caption>   read the "caption" column across both sets
```

The column always comes **last**, after the name list and after any `[ ... ]` filter.

If a dataset does not have the column you asked for, Quarry quietly falls back to that dataset's own default prompt column — and it decides **per dataset**. So with `<q:FOO,BAZ:caption>`, if `FOO` has a `caption` column but `BAZ` does not, Quarry reads `FOO`'s `caption` and `BAZ`'s default. A column override never breaks a multi-dataset tag.

### Printing several columns: `<q:FOO:column1,column2>`

Separate output column names with commas to print several values from **the same randomly chosen row**, in the order you list them:

```text
<q:characters:appearance,clothing,pose>
<q:characters[tags=goth]:appearance, clothing>
<q:characters,creatures:name,description>
```

Quarry joins nonempty values with `, `. For example, `silver hair`, `black leather jacket`, and `leaning against a wall` become:

```text
silver hair, black leather jacket, leaning against a wall
```

Spaces around commas are allowed. Empty values and missing columns are silently skipped, without extra separators or warnings. A dataset with none of the requested columns is skipped entirely. Unlike a single-column override, a multi-column list does not substitute the default prompt column for missing columns. Run Query shows the same joined output.

Filters still apply before a row is picked. When no tag columns are configured, `tags=` searches the dataset's default prompt column for multi-column output.

### A few examples

| Tag | What you get |
| --- | --- |
| `<q:prompts>` | any random prompt |
| `<q:prompts[tags=brunette,punk]>` | tagged brunette or punk |
| `<q:prompts[tags==brunette,punk]>` | tagged brunette and punk |
| `<q:prompts[tags!=nsfw]>` | not tagged nsfw |
| `<q:prompts[score+=0.8]>` | a number column at least 0.8 |
| `<q:prompts[width-=768]>` | a number column up to 768 |
| `<q:prompts[prompt-=500]>` | prompt text no longer than 500 characters |
| `<q:midjourney[prompt=girl]>` | prompts containing "girl" |
| `<q:*[tags=cyberpunk]>` | a cyberpunk entry from any top-level set |
| `<q:**[tags=cyberpunk]>` | …the same, reaching into subfolders too |
| `<q:portraits-*[tags=girl]>` | a "girl" from any of your `portraits-*` sets |
| `<q:midjourney:caption>` | any prompt, read from the `caption` column |
| `<q:midjourney[tags=girl]:caption>` | a "girl" entry, read from the `caption` column |
| `<q[3]:prompts[tags=punk]>` | 3 different punk prompts |

### Type-ahead suggestions

You do not have to remember your dataset names. Start typing a Quarry tag in any prompt box and SwarmUI's suggestion popup helps you fill it in, exactly the way it does for `<wildcard:` and the other built-in tags:

- Type `<q` and **Quarry** shows up in the list of tags.
- After `<q:` you get a list of **every dataset**. Keep typing to narrow it.
- Type a comma and it suggests the **next dataset** for a combined pull (the ones you have already added drop out of the list).
- With a single dataset, type `[` and it lists **that dataset's columns** to filter on, with its tag columns first — so `<q:characters[` immediately offers `tags`. Once you have picked a column it offers the **operators** (`=` any, `==` all, `!=` none, plus `+=` and `-=` for numbers, text length, or array count); after a `;` it starts over for your next condition.
- Type `:` (after the name and any `[filter]`) and it lists the **columns you can use as the prompt** — the default prompt column first — for the [`:column` override](#picking-the-prompt-column-qfoobar). Add a comma to choose another output column; already selected columns are excluded from the suggestions.

Picking a suggestion leaves the tag open so you can keep going — add another comma, open a `[` filter, or just type `>` to finish.

## Build tags by clicking

You never have to type any of this by hand if you would rather not. In the Quarry tab, **click a dataset's name** and Quarry drops a `<q:NAME>` reference straight into your prompt at the cursor. Click that same name again and it pops back out. Datasets your current prompt is using get highlighted in the table, so you can always see what is in play.

### "Add to existing `<q:>` tag"

There is a small checkbox in the tab: **Add to existing `<q:>` tag**, and it is **on by default**. While it is on, clicking a dataset name **adds it to the first `<q:...>` tag you already have**, so clicking "creatures" while `<q:characters>` is sitting in your prompt turns it into `<q:characters,creatures>`. It is the quickest way to build up a combined pull without wrangling brackets yourself. Prefer a separate tag every time? Switch it off, and each click inserts its own.

## Columns: prompt and tags

Each dataset row in the tab has two column settings, and Quarry fills both in with sensible guesses, so most of the time you can leave them alone.

### The prompt column

This is the column whose text actually lands in your prompt. Quarry guesses it by looking for an obvious name like `prompt`, `text`, `caption`, `description`, or `value`, and if none of those exist it just uses the first column in the file. Guessed wrong? Pick the right one from the dropdown and click **Save Settings**.

This setting is the default for every tag. Want a different column for one tag only? Append `:column` to the tag itself — see [Picking the prompt column](#picking-the-prompt-column-qfoobar) above.

### The tag columns

These are the columns the `tags=` keyword searches. Tick whichever columns hold tags (a dataset can have several, and Quarry searches every one you tick). Here is the friendly part: **if you do not set any tag columns at all, `tags=` just searches the prompt column instead.** So `<q:something[tags=girl]>` still does something useful on every dataset, even a bare one that has nothing but a prompt.

## Peek inside: the Preview button

Not sure what is in a dataset, or which column is which? Hit **Preview** on its row. A pop-up shows the first rows of the dataset in a plain table with every column on display, so you can eyeball the real data, spot which column holds the prompt, and see what your tag columns actually look like. Need more? **Load 500 more** pulls the next chunk. There is also a **Clear cache** button for when you have changed a file and want a fresh look.

## Try a tag before generating

Click **Run Query** in the Quarry tab and paste a Quarry tag, such as
`<q:characters[tags=goth]:appearance,clothing>`. You can also enter the query
without the surrounding `<q:...>`. The results show which datasets match, how
many entries match, and example output, so you can adjust a filter before using
it in a generation.

## Good to know

- **Matching is "contains," not exact.** `prompt=girl` finds every entry whose prompt *contains* "girl" (exact matching would rather defeat the point of a wildcard). Capitalization does not matter.
- Tag columns are matched tag by tag, but each tag is still "contains," so `tags=girl` also matches `girls` and `young girl` (and yes, `tags=punk` will match `cyberpunk` too).
- Values can include spaces (`long hair`), but these characters are reserved and cannot appear inside a value: `; , = ! [ ] < >`
- Need several picks from a single tag? SwarmUI's built-in count works: `<q[3]:characters>` gives you 3 different entries.

## Development and dataset maintenance

The sections below cover building the extension and managing dataset files from
the command line. For everyday use in SwarmUI, use the Quarry tab and the prompt
tags above.

### Building and testing

Quarry reads your data with [DuckDB](https://duckdb.org/) and its [LanceDB](https://lancedb.com/) reader. Building from source:

```bash
npm install
npm run build      # build the UI
./run-tests        # run the test suite
```

### Preparation resources and recovery

Cleanup uses a default `32GB` DuckDB memory budget (`--memory-limit` overrides it).
Cleanup and index spill files live beside the output, so large index builds use
that filesystem rather than the system `/tmp`. The cleanup budget does not limit
Lance's index-building memory.

If indexing fails or is cancelled after conversion, Quarry keeps the cleaned
dataset in a `.quarry-prep-*` checkpoint directory and prints a recovery command:

```bash
./quarry prep --resume /path/to/.quarry-prep-xxxxxxxx
```

Resume skips conversion and deduplication, verifies the checkpoint's logical values and derived search data, and reuses the completed representation. Older prep checkpoints are upgraded before publication. The final output is published only after logical-value and index verification succeeds; the source
and any existing output remain untouched. Temporary cleanup/index files are
removed, while the checkpoint remains until a successful resume.

### Optimize existing Lance datasets

```bash
./quarry lance optimize ~/data/AIConfigs/Quarry/nl --dry-run
./quarry lance optimize ~/data/AIConfigs/Quarry/nl
./quarry lance optimize /path/to/specific.lance
```

A dataset path processes only that dataset. A regular directory processes its
immediate child datasets, without recursion, and errors if none are present.
Datasets are processed sequentially; a failure is reported and the command
continues with the remaining datasets, returning a nonzero exit status.
Already-optimized datasets are skipped. The final report counts optimized,
skipped, and failed datasets and lists each failure with its reason.
At the end, a size summary shows the total before and after, plus bytes and
percentage saved (or increased), for successfully optimized datasets. Dry runs
do not estimate savings.

The rewrite preserves live rows, row order, logical column order, nulls, and exact
original text. It removes recognized `__lc` companions, stores lowercase text in
flat string columns, adds lossless binary `__case` patches, and rebuilds NGRAM
indexes. Structured columns retain their original nested values; each nested text
field gets a hidden lowercase search column spanning all records and an NGRAM
index. These fields are discovered from the schema, not a fixed list. For example,
a record with 13 text fields gets 13 search columns regardless of array length.
Supported existing scalar indexes are retained;
unsupported indexes and case-sensitive string BTREE/BITMAP indexes are rejected
before replacement. Non-text columns keep their types and values. Optimize never
deduplicates rows. Search columns add storage, so nested indexing is not a promise
of reduced dataset size.

Only the current Lance version survives: deleted rows, obsolete physical columns,
and previous versions are discarded. Index creation can advance the version
number; it does not imply retained history. No permanent backup or audit copy is
kept. The command verifies reconstructed values before replacing the original,
and restores the original if publication fails. It needs temporary space beside
the dataset for the rewritten data, indexes, and index spill files. Stop readers
and writers before migrating; live concurrent replacement is not supported.

Quarry automatically restores casing for prompts, search results, and previews.
For flat text, only entirely ASCII alphanumeric terms of at least three characters
use the NGRAM route; other terms scan to preserve substring semantics. Nested
search can use the longest literal ASCII alphanumeric run of at least three
characters from a positive term to narrow candidates, then checks the complete
condition against the original records. Terms without that run and negative
conditions retain exact scan behavior. Indices never replace the checks for
record position, shared variables, or distinct subjects, and never change counts
or output selection.
ASCII casing uses sparse UTF-8 byte positions or a bitmap; Unicode casing changes
use the full original UTF-8 value when necessary. No Unicode normalization is
applied. Keep `quarry-storage.json` with the dataset: it identifies the format and
its casing and search columns. Other Lance readers see physical lowercase flat
values unless they implement this codec; nested values retain their original
casing. See [the storage specification](docs/casing-storage.md).

Structured datasets record the finalized Lance manifest in a version-2 storage
descriptor. If the dataset changes outside Quarry, untrusted search columns are
not used. Datasets containing only original nested values remain readable with
exact searches; run `./quarry lance optimize DATASET.lance` to regenerate their
search data. If the dataset also has flat casing patches, a changed snapshot is
an error: rebuild from the original input because those patches can no longer be
safely paired with the text. Do not edit the descriptor to bypass this check.

Use `./quarry prep` to select, rename, reorder, or clean encoded input into a new
dataset. `./quarry columns reorder DATASET.lance score,prompt` reorders in place,
preserving logical values, companion columns, and supported scalar indexes, and
refreshing the structured dataset's snapshot after verification.
The rewrite rebuilds indexes before replacing the original dataset; unsupported
index types are rejected before writing. `./quarry lance prep --no-clean` can
rebuild indexes, while its legacy in-place cleaning pass rejects encoded datasets.

The `__lc` format is **deprecated but remains supported** by C# search routing.
Existing datasets work without migration. The separate image-history index still
uses its existing format. New `./quarry prep` outputs use casing storage by default.

### Destructive lowercase conversion (legacy)

To permanently replace mixed-case text with its existing lowercase search companions:

```bash
./quarry lance lowercase ~/data/AIConfigs/Quarry
```

This processes only immediate child `.lance` datasets, or just one dataset if you
pass its directory directly. Each `X` with a matching `X__lc` receives the companion's
values, and `X__lc` is removed. Other columns and row/column order are preserved.
Datasets without matching pairs are left alone. Scalar indexes are rebuilt, and old
versions and replaced data files are deleted; original capitalization cannot be
recovered afterward. The rewrite streams data, but needs temporary disk space for
the new data and indexes before the old files can be removed. Run it while the
datasets are not being edited or queried.
