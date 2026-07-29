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
    numeric?: boolean;
}

const MAX_DATASET_SUGGESTIONS = 50;

const FILTER_OPERATORS: ReadonlyArray<{
    op: string;
    hint: string;
    numericOnly?: boolean;
}> = [
    { op: "=", hint: "match any of the values" },
    { op: "==", hint: "match all of the values" },
    { op: "!=", hint: "match none of the values" },
    { op: "+=", hint: "at least (number columns)", numericOnly: true },
    { op: "-=", hint: "at most (number columns)", numericOnly: true },
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
                numeric: col.numeric ?? false,
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
    const columns = orderColumnsForFilter(dataset);
    const frag = clause.trim().toLowerCase();
    const exact = columns.find((c) => c.name.toLowerCase() === frag);
    if (exact) {
        return FILTER_OPERATORS.filter(
            (o) => !o.numericOnly || exact.numeric,
        ).map((o) => ({
            apply: `${head}${exact.name}${o.op}`,
            label: o.op,
            hint: o.hint,
        }));
    }
    return filterByFragment(columns, frag, (c) => c.name, false).map((c) => ({
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
    const overridePart = suffix.slice(colonIdx + 1);
    const lastComma = overridePart.lastIndexOf(",");
    const frag = (
        lastComma === -1 ? overridePart : overridePart.slice(lastComma + 1)
    )
        .trim()
        .toLowerCase();
    const chosen = new Set(
        (lastComma === -1 ? "" : overridePart.slice(0, lastComma + 1))
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter((s) => s.length > 0),
    );
    const candidates = orderColumnsForPrompt(named).filter(
        (c) => !chosen.has(c.name.toLowerCase()),
    );
    const matches = filterByFragment(
        candidates,
        frag,
        (c) => c.name,
        false,
    );
    if (matches.length === 1 && matches[0].name.toLowerCase() === frag) {
        return [];
    }
    const applyHead = `<q:${suffix.slice(
        0,
        colonIdx + 1 + (lastComma === -1 ? 0 : lastComma + 1),
    )}`;
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
    const lastOpen = suffix.lastIndexOf("[");
    const lastClose = suffix.lastIndexOf("]");
    if (lastOpen > lastClose) {
        return completeFilterColumn(suffix, lastOpen, list);
    }
    const colonIdx = suffix.indexOf(":", lastClose + 1);
    if (colonIdx !== -1) {
        return completePromptColumn(suffix, colonIdx, list);
    }
    if (lastClose !== -1) {
        return [];
    }
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
