// Hooks Quarry into SwarmUI's prompt-tag autocompleter (genpage/gentab/prompttools.js). Registering a `q`
// prefix makes `<q` offer "Quarry" in the suggestion popover (like every other `<tag`), `<q:` list every
// dataset, a comma offer the next dataset in a combined pull, `[` — when the tag targets a single dataset — list
// that dataset's columns (its configured tag columns first) to filter on (then the `=`/`==`/`!=` operators once a
// column is chosen), and `:` list the columns usable as the prompt-column override.
//
// The suggestion engine (computeQuarryCompletions) is a pure function of (typed text, dataset list) so it can be
// unit-tested without the DOM or the core autocompleter. registerQuarryCompletion() is the thin glue that wires
// it to prompttools.js, and setCompletionDatasets() keeps its dataset list in sync with the settings panel.

import type { ColumnDto, DatasetDto } from "./types";
import { escapeHtml } from "./util";

// The slice of a dataset the autocompleter needs: its name, columns, the columns configured as tag columns, the
// resolved prompt column (what `tags=` falls back to when no tag columns are set), and the row count (a hint).
export interface CompletionDataset {
    name: string;
    columns: ColumnDto[];
    tagColumns: string[];
    promptColumn: string | null;
    rowCount: number | null;
}

let datasets: CompletionDataset[] = [];

/// Replaces the dataset list the `<q:...>` autocompleter draws from. Called whenever the settings panel loads or
/// refreshes the table (settings.ts). Datasets that failed to read are dropped — they expose no usable columns.
export const setCompletionDatasets = (list: DatasetDto[] | undefined): void => {
    datasets = (list ?? [])
        .filter((d) => !d.error)
        .map((d) => ({
            name: d.name,
            columns: d.columns ?? [],
            tagColumns: d.configuredTagColumns ?? [],
            promptColumn: d.resolvedPromptColumn,
            rowCount: d.rowCount ?? null,
        }));
};

/// One suggestion: `apply` is the full replacement text (starting at the tag's opening `<`), `label` is shown in
/// the popover, and `hint` is the dimmed descriptor after it. The tag is intentionally left open (no closing
/// `>`) so the user can keep going — add a comma for another dataset, `[` for a filter, or `>` to finish.
export interface QuarryCompletion {
    apply: string;
    label: string;
    hint: string;
}

interface FilterColumn {
    name: string;
    hint: string;
}

const MAX_DATASET_SUGGESTIONS = 50;

// The operators a filter clause can use, offered once its column is complete (mirrors the README: `=` any,
// `==` all, `!=` none).
const FILTER_OPERATORS: ReadonlyArray<{ op: string; hint: string }> = [
    { op: "=", hint: "match any of the values" },
    { op: "==", hint: "match all of the values" },
    { op: "!=", hint: "match none of the values" },
];

const findDataset = (
    list: CompletionDataset[],
    name: string,
): CompletionDataset | null => {
    const low = name.trim().toLowerCase();
    return list.find((d) => d.name.toLowerCase() === low) ?? null;
};

// Keeps items whose name contains `frag`. When `prefixFirst`, names that START with the fragment sort ahead of
// those that merely contain it (nicer while typing a name); otherwise the input order is preserved — used for
// columns, where the tag-columns-first ordering is what we want to keep.
const filterByFragment = <T>(
    items: T[],
    frag: string,
    getName: (item: T) => string,
    prefixFirst: boolean,
): T[] => {
    if (frag.length === 0) {
        return items.slice();
    }
    const matched = items.filter((i) =>
        getName(i).toLowerCase().includes(frag),
    );
    if (!prefixFirst) {
        return matched;
    }
    const starts = matched.filter((i) =>
        getName(i).toLowerCase().startsWith(frag),
    );
    const rest = matched.filter(
        (i) => !getName(i).toLowerCase().startsWith(frag),
    );
    return starts.concat(rest);
};

// Orders a dataset's columns for filter-clause completion: configured tag columns first (these are what `tags=`
// searches), then — only if no tag columns are configured — the prompt column (the documented fallback `tags=`
// uses), then every remaining column in its natural order.
const orderColumnsForFilter = (dataset: CompletionDataset): FilterColumn[] => {
    const byLower = new Map(
        dataset.columns.map((c) => [c.name.toLowerCase(), c]),
    );
    const used = new Set<string>();
    const result: FilterColumn[] = [];
    const push = (col: ColumnDto, hint: string): void => {
        if (!used.has(col.name.toLowerCase())) {
            used.add(col.name.toLowerCase());
            result.push({ name: col.name, hint });
        }
    };
    for (const tag of dataset.tagColumns) {
        const col = byLower.get(tag.trim().toLowerCase());
        if (col) {
            push(col, "tag column");
        }
    }
    if (result.length === 0 && dataset.promptColumn) {
        const col = byLower.get(dataset.promptColumn.toLowerCase());
        if (col) {
            push(col, "prompt column");
        }
    }
    for (const col of dataset.columns) {
        push(col, col.kind === "list" ? "list column" : "column");
    }
    return result;
};

// Suggestions for the dataset-name position: a comma-separated list, where the segment after the last comma is
// being typed. Already-chosen names are excluded so a combined pull never lists a duplicate.
const completeDatasetName = (
    suffix: string,
    list: CompletionDataset[],
): QuarryCompletion[] => {
    const commaIdx = suffix.lastIndexOf(",");
    const frag = suffix
        .slice(commaIdx + 1)
        .trim()
        .toLowerCase();
    const chosen = new Set(
        suffix
            .slice(0, commaIdx + 1)
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter((s) => s.length > 0),
    );
    const candidates = list.filter((d) => !chosen.has(d.name.toLowerCase()));
    const matches = filterByFragment(candidates, frag, (d) => d.name, true);
    // The tag is left open after a pick; if the sole match is exactly what's already typed there is nothing
    // left to add, so suggest nothing and let the popover close instead of lingering on the finished name.
    if (matches.length === 1 && matches[0].name.toLowerCase() === frag) {
        return [];
    }
    const head = `<q:${suffix.slice(0, commaIdx + 1)}`;
    return matches.slice(0, MAX_DATASET_SUGGESTIONS).map((d) => ({
        apply: head + d.name,
        label: d.name,
        hint: d.rowCount != null ? `${d.rowCount.toLocaleString()} rows` : "",
    }));
};

// Suggestions for a filter clause's column position, i.e. just after `[` or after a `;` inside the brackets.
// Only offered when the tag targets exactly one dataset (otherwise it is ambiguous which dataset's columns to
// list), and only while typing the column — once an operator appears we are entering the value.
const completeFilterColumn = (
    suffix: string,
    lastOpen: number,
    list: CompletionDataset[],
): QuarryCompletion[] => {
    const names = suffix
        .slice(0, lastOpen)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    if (names.length !== 1) {
        return [];
    }
    const dataset = findDataset(list, names[0]);
    if (!dataset) {
        return [];
    }
    const inner = suffix.slice(lastOpen + 1);
    const semiIdx = inner.lastIndexOf(";");
    const clause = semiIdx === -1 ? inner : inner.slice(semiIdx + 1);
    // An operator (`=`, `==`, `!=`) means the column is already chosen and a value is being typed — stop.
    if (/[=!]/.test(clause)) {
        return [];
    }
    // Rebuild the text up to the start of the current clause (names + `[` + any earlier `clause;` parts); the
    // chosen column or operator is appended onto this.
    const head = `<q:${suffix.slice(0, lastOpen + 1 + (semiIdx === -1 ? 0 : semiIdx + 1))}`;
    const columns = orderColumnsForFilter(dataset);
    const frag = clause.trim().toLowerCase();
    // Once the column name is complete, suggest the operators that follow it (rather than re-listing the column).
    const exact = columns.find((c) => c.name.toLowerCase() === frag);
    if (exact) {
        return FILTER_OPERATORS.map((o) => ({
            apply: `${head}${exact.name}${o.op}`,
            label: o.op,
            hint: o.hint,
        }));
    }
    // Otherwise list the columns to filter on (tag columns first), narrowed by what's typed.
    return filterByFragment(columns, frag, (c) => c.name, false).map((c) => ({
        apply: head + c.name,
        label: c.name,
        hint: c.hint,
    }));
};

// Orders columns for prompt-column-override completion (`<q:NAME:col>`): each named dataset's current prompt
// column first (the sensible default, and usually a text column), then every other column across the named
// datasets in order. Any column is a valid override — it applies per dataset, falling back where it is absent.
const orderColumnsForPrompt = (named: CompletionDataset[]): FilterColumn[] => {
    const used = new Set<string>();
    const result: FilterColumn[] = [];
    const push = (col: ColumnDto, hint: string): void => {
        if (!used.has(col.name.toLowerCase())) {
            used.add(col.name.toLowerCase());
            result.push({ name: col.name, hint });
        }
    };
    for (const dataset of named) {
        const col = dataset.promptColumn
            ? dataset.columns.find(
                  (c) =>
                      c.name.toLowerCase() ===
                      dataset.promptColumn?.toLowerCase(),
              )
            : undefined;
        if (col) {
            push(col, "default prompt column");
        }
    }
    for (const dataset of named) {
        for (const col of dataset.columns) {
            push(col, col.kind === "list" ? "list column" : "column");
        }
    }
    return result;
};

// Suggestions for the prompt-column override position — just after the ":" that follows the names and any
// "[filter]". Lists the columns usable as the prompt, drawn from every dataset the tag names (the override
// applies per dataset, so any of their columns is a valid choice).
const completePromptColumn = (
    suffix: string,
    colonIdx: number,
    list: CompletionDataset[],
): QuarryCompletion[] => {
    const head = suffix.slice(0, colonIdx);
    const bracketIdx = head.indexOf("[");
    const namesPart = bracketIdx === -1 ? head : head.slice(0, bracketIdx);
    const named = namesPart
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((n) => findDataset(list, n))
        .filter((d): d is CompletionDataset => d !== null);
    if (named.length === 0) {
        return [];
    }
    const frag = suffix
        .slice(colonIdx + 1)
        .trim()
        .toLowerCase();
    const matches = filterByFragment(
        orderColumnsForPrompt(named),
        frag,
        (c) => c.name,
        false,
    );
    if (matches.length === 1 && matches[0].name.toLowerCase() === frag) {
        return [];
    }
    const applyHead = `<q:${suffix.slice(0, colonIdx + 1)}`;
    return matches.map((c) => ({
        apply: applyHead + c.name,
        label: c.name,
        hint: c.hint,
    }));
};

/// Computes the `<q:...>` suggestions for `suffix` (everything the user has typed after `q:`, up to the cursor).
/// Pure: pass an explicit dataset `list` in tests; production calls use the module's current list.
export const computeQuarryCompletions = (
    suffix: string,
    list: CompletionDataset[] = datasets,
): QuarryCompletion[] => {
    const lastOpen = suffix.lastIndexOf("[");
    const lastClose = suffix.lastIndexOf("]");
    if (lastOpen > lastClose) {
        return completeFilterColumn(suffix, lastOpen, list);
    }
    // A ":column" prompt-column override trails the names and any closed "[filter]". Find its ":" the same way
    // the backend does — only at/after the filter's closing "]" — so a ":" inside a filter value is ignored.
    const colonIdx = suffix.indexOf(":", lastClose + 1);
    if (colonIdx !== -1) {
        return completePromptColumn(suffix, colonIdx, list);
    }
    if (lastClose !== -1) {
        // A closed "[...]" filter with no ":column" yet — nothing left to complete.
        return [];
    }
    return completeDatasetName(suffix, list);
};

let registered = false;

/// Registers the `q` prefix with SwarmUI's prompt-tab autocompleter so `<q:...>` tags get live suggestions.
/// Idempotent, and a no-op when the core autocompleter isn't present (e.g. under tests). Call once at boot.
export const registerQuarryCompletion = (): void => {
    if (registered) {
        return;
    }
    if (
        typeof promptTabComplete === "undefined" ||
        !promptTabComplete ||
        typeof promptTabComplete.registerPrefix !== "function"
    ) {
        return;
    }
    promptTabComplete.registerPrefix(
        "q",
        "Quarry: a random entry from a dataset (a filterable wildcard) — lists your datasets",
        (suffix: string) =>
            computeQuarryCompletions(suffix).map((c) => ({
                raw: true,
                name: c.apply,
                clean_html: escapeHtml(c.label),
                desc: c.hint,
            })),
    );
    registered = true;
};
