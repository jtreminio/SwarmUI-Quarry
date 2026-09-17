import { querySections } from "./querysyntax";
import type { ColumnDto, DatasetDto } from "./types";
import { escapeHtml } from "./util";

export interface CompletionDataset {
    name: string;
    columns: ColumnDto[];
    tagColumns: string[];
    promptColumn: string | null;
    rowCount: number | null;
}

let datasets: CompletionDataset[] = [];

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

export interface QuarryCompletion {
    apply: string;
    label: string;
    hint: string;
}

interface FilterColumn {
    name: string;
    hint: string;
    comparable?: boolean;
}

const MAX_DATASET_SUGGESTIONS = 50;

const FILTER_OPERATORS: ReadonlyArray<{
    op: string;
    hint: string;
    comparisonOnly?: boolean;
}> = [
    { op: "=", hint: "match any of the values" },
    { op: "==", hint: "match all of the values" },
    { op: "!=", hint: "match none of the values" },
    {
        op: "+=",
        hint: "at least (number, text length, or array count)",
        comparisonOnly: true,
    },
    {
        op: "-=",
        hint: "at most (number, text length, or array count)",
        comparisonOnly: true,
    },
];

const findDataset = (
    list: CompletionDataset[],
    name: string,
): CompletionDataset | null => {
    const low = name.trim().toLowerCase();
    return list.find((d) => d.name.toLowerCase() === low) ?? null;
};

const filterByFragment = <T>(
    items: T[],
    frag: string,
    getName: (item: T) => string,
    prefixFirst: boolean,
    key = (value: string) => value.toLowerCase(),
): T[] => {
    if (frag.length === 0) {
        return items.slice();
    }
    const matched = items.filter((i) => key(getName(i)).includes(frag));
    if (!prefixFirst) {
        return matched;
    }
    const starts = matched.filter((i) => key(getName(i)).startsWith(frag));
    const rest = matched.filter((i) => !key(getName(i)).startsWith(frag));
    return starts.concat(rest);
};

const orderColumnsForFilter = (dataset: CompletionDataset): FilterColumn[] => {
    const byLower = new Map(
        dataset.columns.map((c) => [c.name.toLowerCase(), c]),
    );
    const used = new Set<string>();
    const result: FilterColumn[] = [];
    const push = (col: ColumnDto, hint: string): void => {
        if (!used.has(col.name.toLowerCase())) {
            used.add(col.name.toLowerCase());
            result.push({
                name: col.name,
                hint,
                comparable: col.kind !== "object",
            });
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

// Column and field names ignore case; binding names inside selectors do not.
const fieldPathKey = (value: string): string =>
    value
        .replace(/\[\*\]/g, "[]")
        .split(/(\[[^\]]*\]?)/)
        .map((part) => (part.startsWith("[") ? part : part.toLowerCase()))
        .join("");

const nestedColumns = (
    columns: FilterColumn[],
    datasets: CompletionDataset[],
    fragment: string,
    output = false,
    query = "",
): FilterColumn[] => {
    const result = [...columns];
    const used = new Set(result.map((c) => fieldPathKey(c.name)));
    const add = (name: string, hint: string, comparable: boolean) => {
        if (used.has(fieldPathKey(name))) return;
        used.add(fieldPathKey(name));
        result.push({ name, hint, comparable });
    };
    for (const dataset of datasets) {
        for (const col of dataset.columns) {
            if (!col.fields?.length) {
                if (col.kind === "list")
                    add(`${col.name}[]`, "all elements", true);
                continue;
            }
            const selectors = new Set(["", "[]", "[0]"]);
            const root = fragment.match(/^([^.[\]]+)(\[[^\]]*\])/);
            if (root?.[1].toLowerCase() === col.name.toLowerCase())
                selectors.add(root[2] === "[*]" ? "[]" : root[2]);
            if (!output) {
                selectors.add("[i]");
                selectors.add("[n]");
            } else {
                for (const match of query.matchAll(
                    /([^.[\];: ]+)\[([a-zA-Z_][a-zA-Z_0-9]*)\]/g,
                )) {
                    if (match[1].toLowerCase() === col.name.toLowerCase())
                        selectors.add(`[${match[2]}]`);
                }
            }
            for (const selector of col.kind === "object" ? [""] : selectors) {
                const name = col.name + selector;
                const all =
                    col.kind === "list" &&
                    (selector === "" || selector === "[]");
                add(name, all ? "all records" : "selected record", all);
                for (const field of col.fields) {
                    add(`${name}.${field.name}`, "record field", !all);
                }
            }
        }
    }
    return result;
};

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
    if (/[=!]/.test(clause)) {
        return [];
    }
    const head = `<q:${suffix.slice(0, lastOpen + 1 + (semiIdx === -1 ? 0 : semiIdx + 1))}`;
    const fragment = clause.trim();
    const frag = fieldPathKey(fragment);
    const columns = nestedColumns(
        orderColumnsForFilter(dataset),
        [dataset],
        fragment,
    );
    const exact = columns.find((c) => fieldPathKey(c.name) === frag);
    if (exact) {
        return FILTER_OPERATORS.filter(
            (o) => !o.comparisonOnly || exact.comparable,
        ).map((o) => ({
            apply: `${head}${exact.name}${o.op}`,
            label: o.op,
            hint: o.hint,
        }));
    }
    return filterByFragment(
        columns,
        frag,
        (c) => c.name,
        false,
        fieldPathKey,
    ).map((c) => ({
        apply: head + c.name,
        label: c.name,
        hint: c.hint,
    }));
};

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
    const columnsPart = suffix.slice(colonIdx + 1);
    const commaIdx = columnsPart.lastIndexOf(",");
    const outputKey = (value: string) =>
        fieldPathKey(value).replace(/\[\]/g, "");
    const chosen = new Set(
        columnsPart
            .slice(0, commaIdx + 1)
            .split(",")
            .map((s) => outputKey(s.trim())),
    );
    const fragment = columnsPart.slice(commaIdx + 1).trim();
    const frag = fieldPathKey(fragment);
    const matches = filterByFragment(
        nestedColumns(
            orderColumnsForPrompt(named),
            named,
            fragment,
            true,
            head,
        ).filter((c) => !chosen.has(outputKey(c.name))),
        frag,
        (c) => c.name,
        false,
        fieldPathKey,
    );
    if (matches.length === 1 && fieldPathKey(matches[0].name) === frag) {
        return [];
    }
    const applyHead = `<q:${suffix.slice(0, colonIdx + 1)}${columnsPart.slice(0, commaIdx + 1)}`;
    return matches.map((c) => ({
        apply: applyHead + c.name,
        label: c.name,
        hint: c.hint,
    }));
};

export const computeQuarryCompletions = (
    suffix: string,
    list: CompletionDataset[] = datasets,
): QuarryCompletion[] => {
    const sections = querySections(suffix);
    if (sections.pipe >= 0) {
        if (sections.quoted) return [];
        const fragment = suffix.slice(sections.optionStart).trim();
        if (fragment.includes("=")) return [];
        const options = [
            { name: "keys", hint: "print field names" },
            {
                name: 'record_separator="',
                hint: "separator between records (rs)",
            },
            {
                name: 'field_separator="',
                hint: "separator between fields (fs)",
            },
            { name: 'rs="', hint: "record separator" },
            { name: 'fs="', hint: "field separator" },
        ];
        return options
            .filter((o) => o.name.startsWith(fragment))
            .map((o) => ({
                apply: `<q:${suffix.slice(0, sections.optionStart)}${o.name}`,
                label: o.name,
                hint: o.hint,
            }));
    }
    if (sections.colon >= 0)
        return completePromptColumn(suffix, sections.colon, list);
    if (sections.filterOpen >= 0 && sections.filterClose < 0) {
        return completeFilterColumn(suffix, sections.filterOpen, list);
    }
    if (sections.filterClose >= 0) return [];
    return completeDatasetName(suffix, list);
};

let registered = false;

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
