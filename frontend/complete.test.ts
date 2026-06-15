import { describe, expect, it } from "@jest/globals";
import {
    type CompletionDataset,
    computeQuarryCompletions,
    setCompletionDatasets,
} from "./complete";
import type { DatasetDto } from "./types";

// A handful of datasets exercising the cases the completer distinguishes: configured tag columns, no tag columns
// (prompt-column fallback), a non-tag list column, and a dataset with an uncounted row count.
const characters: CompletionDataset = {
    name: "characters",
    columns: [
        { name: "prompt", kind: "scalar" },
        { name: "tags", kind: "list" },
        { name: "source", kind: "scalar" },
    ],
    tagColumns: ["tags"],
    promptColumn: "prompt",
    rowCount: 1234,
};
const creatures: CompletionDataset = {
    name: "creatures",
    columns: [
        { name: "caption", kind: "scalar" },
        { name: "kind", kind: "scalar" },
    ],
    tagColumns: [],
    promptColumn: "caption",
    rowCount: 50,
};
const styled: CompletionDataset = {
    name: "styled",
    columns: [
        { name: "prompt", kind: "scalar" },
        { name: "styles", kind: "list" },
    ],
    tagColumns: [],
    promptColumn: "prompt",
    rowCount: null,
};
const ALL: CompletionDataset[] = [characters, creatures, styled];

const labels = (suffix: string, list = ALL): string[] =>
    computeQuarryCompletions(suffix, list).map((c) => c.label);

describe("computeQuarryCompletions — dataset names", () => {
    it("lists every dataset for a bare `<q:`", () => {
        expect(labels("")).toEqual(["characters", "creatures", "styled"]);
    });

    it("inserts an open `<q:NAME` (no closing `>`) so the tag can be continued", () => {
        const [first] = computeQuarryCompletions("", ALL);
        expect(first).toEqual({
            apply: "<q:characters",
            label: "characters",
            hint: "1,234 rows",
        });
    });

    it("shows the row count as a hint, or nothing when uncounted", () => {
        const byName = new Map(
            computeQuarryCompletions("", ALL).map((c) => [c.label, c.hint]),
        );
        expect(byName.get("creatures")).toBe("50 rows");
        expect(byName.get("styled")).toBe("");
    });

    it("filters by what is typed, prefix matches first", () => {
        // "c" matches characters and creatures (both start with it); "rea" only creatures (contains).
        expect(labels("c")).toEqual(["characters", "creatures"]);
        expect(labels("rea")).toEqual(["creatures"]);
    });

    it("suggests the next dataset after a comma, excluding ones already chosen", () => {
        expect(labels("characters,")).toEqual(["creatures", "styled"]);
        expect(labels("characters,creatures,")).toEqual(["styled"]);
    });

    it("completes a partial name after a comma, preserving the earlier names", () => {
        expect(computeQuarryCompletions("characters,cr", ALL)).toEqual([
            {
                apply: "<q:characters,creatures",
                label: "creatures",
                hint: "50 rows",
            },
        ]);
    });

    it("offers nothing once the sole match equals exactly what is typed", () => {
        // After picking a unique name the tag is left open; re-suggesting it would just make the popover linger.
        expect(labels("creatures")).toEqual([]);
    });
});

describe("computeQuarryCompletions — filter columns", () => {
    it("lists a single dataset's columns when `[` is opened, tag columns first", () => {
        expect(labels("characters[")).toEqual(["tags", "prompt", "source"]);
    });

    it("labels columns by role", () => {
        const byName = new Map(
            computeQuarryCompletions("characters[", ALL).map((c) => [
                c.label,
                c.hint,
            ]),
        );
        expect(byName.get("tags")).toBe("tag column");
        expect(byName.get("prompt")).toBe("column");
        expect(byName.get("source")).toBe("column");
    });

    it("surfaces the prompt column first when no tag columns are configured", () => {
        // `tags=` falls back to the prompt column, so it leads; remaining columns follow in natural order.
        const cols = computeQuarryCompletions("creatures[", ALL);
        expect(cols.map((c) => c.label)).toEqual(["caption", "kind"]);
        expect(cols[0].hint).toBe("prompt column");
    });

    it("marks a non-tag list column as a list column", () => {
        const styles = computeQuarryCompletions("styled[", ALL).find(
            (c) => c.label === "styles",
        );
        expect(styles?.hint).toBe("list column");
    });

    it("inserts an open `<q:NAME[col` ready for the operator and value", () => {
        expect(computeQuarryCompletions("characters[", ALL)[0]).toEqual({
            apply: "<q:characters[tags",
            label: "tags",
            hint: "tag column",
        });
    });

    it("filters the column list by what is typed", () => {
        expect(labels("characters[so")).toEqual(["source"]);
        expect(labels("characters[ta")).toEqual(["tags"]);
    });

    it("suggests the three operators once the column name is complete", () => {
        expect(computeQuarryCompletions("characters[tags", ALL)).toEqual([
            {
                apply: "<q:characters[tags=",
                label: "=",
                hint: "match any of the values",
            },
            {
                apply: "<q:characters[tags==",
                label: "==",
                hint: "match all of the values",
            },
            {
                apply: "<q:characters[tags!=",
                label: "!=",
                hint: "match none of the values",
            },
        ]);
    });

    it("offers operators for a complete column in a later clause too", () => {
        expect(labels("characters[source")).toEqual(["=", "==", "!="]);
        expect(
            computeQuarryCompletions("characters[tags=girl;source", ALL)[0],
        ).toEqual({
            apply: "<q:characters[tags=girl;source=",
            label: "=",
            hint: "match any of the values",
        });
    });

    it("does not offer columns for a multi-dataset tag", () => {
        expect(labels("characters,creatures[")).toEqual([]);
    });

    it("stops once an operator is typed (now entering the value)", () => {
        expect(labels("characters[tags=gi")).toEqual([]);
        expect(labels("characters[tags!")).toEqual([]);
    });

    it("offers columns again for a second clause after a semicolon", () => {
        expect(
            computeQuarryCompletions("characters[tags=girl;so", ALL),
        ).toEqual([
            {
                apply: "<q:characters[tags=girl;source",
                label: "source",
                hint: "column",
            },
        ]);
    });

    it("offers nothing once the filter bracket is closed (and no `:` typed yet)", () => {
        expect(labels("characters[tags=girl]")).toEqual([]);
    });

    it("offers nothing for an unknown dataset", () => {
        expect(labels("nope[")).toEqual([]);
    });
});

describe("computeQuarryCompletions — prompt column override", () => {
    it("lists the columns usable as the prompt after `:`, the default first", () => {
        expect(labels("characters:")).toEqual(["prompt", "tags", "source"]);
        expect(computeQuarryCompletions("characters:", ALL)[0].hint).toBe(
            "default prompt column",
        );
    });

    it("lists columns after `:` even when a `[filter]` precedes it", () => {
        // The reported gap: <q:NAME[filter]: must still hint columns.
        expect(labels("characters[full]:")).toEqual([
            "prompt",
            "tags",
            "source",
        ]);
        expect(labels("characters[tags=girl]:")).toEqual([
            "prompt",
            "tags",
            "source",
        ]);
    });

    it("inserts an open `<q:NAME[filter]:col`, keeping the names and filter", () => {
        expect(
            computeQuarryCompletions("characters[tags=girl]:", ALL)[0],
        ).toEqual({
            apply: "<q:characters[tags=girl]:prompt",
            label: "prompt",
            hint: "default prompt column",
        });
    });

    it("filters the column list by what is typed after `:`", () => {
        expect(labels("characters:so")).toEqual(["source"]);
    });

    it("unions columns across every named dataset, each default first", () => {
        // The override applies per dataset, so any of their columns is valid; both defaults lead.
        const cols = computeQuarryCompletions("characters,creatures:", ALL);
        expect(cols.map((c) => c.label)).toEqual([
            "prompt",
            "caption",
            "tags",
            "source",
            "kind",
        ]);
        expect(cols.slice(0, 2).map((c) => c.hint)).toEqual([
            "default prompt column",
            "default prompt column",
        ]);
    });

    it("does not treat a `:` inside a filter value as the prompt-column separator", () => {
        expect(labels("characters[source=a:b")).toEqual([]);
        expect(labels("characters[source=a:b]")).toEqual([]);
    });

    it("offers nothing for an unknown dataset", () => {
        expect(labels("nope:")).toEqual([]);
    });
});

describe("setCompletionDatasets", () => {
    const dto = (over: Partial<DatasetDto>): DatasetDto => ({
        name: "x",
        columns: [{ name: "prompt", kind: "scalar" }],
        resolvedPromptColumn: "prompt",
        configuredPromptColumn: null,
        configuredTagColumns: [],
        rowCount: null,
        error: null,
        ...over,
    });

    it("feeds the module-level dataset list used by the no-arg completer", () => {
        setCompletionDatasets([dto({ name: "alpha" }), dto({ name: "beta" })]);
        expect(computeQuarryCompletions("").map((c) => c.label)).toEqual([
            "alpha",
            "beta",
        ]);
    });

    it("drops datasets that failed to read (no usable columns)", () => {
        setCompletionDatasets([
            dto({ name: "good" }),
            dto({ name: "broken", error: "could not open" }),
        ]);
        expect(computeQuarryCompletions("").map((c) => c.label)).toEqual([
            "good",
        ]);
    });

    it("tolerates an undefined list", () => {
        setCompletionDatasets(undefined);
        expect(computeQuarryCompletions("")).toEqual([]);
    });
});
