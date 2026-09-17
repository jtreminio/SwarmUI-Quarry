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

describe("nested selectors and formatting", () => {
    const nested: CompletionDataset = {
        name: "portraits",
        columns: [
            {
                name: "subject",
                kind: "list",
                fields: [{ name: "hair" }, { name: "eyes" }],
            },
        ],
        tagColumns: [],
        promptColumn: "subject",
        rowCount: 10,
    };
    it("completes fields inside the outer filter after a record selector", () => {
        expect(labels("portraits[subject[i].h", [nested])).toEqual([
            "subject[i].hair",
        ]);
        expect(
            labels("portraits[subject[i].hair=blond;subject[n].e", [nested]),
        ).toEqual(["subject[n].eyes"]);
        expect(labels("portraits[subject[12].h", [nested])).toEqual([
            "subject[12].hair",
        ]);
    });
    it("offers count comparisons only for whole arrays, and length comparisons for individual fields", () => {
        expect(labels("portraits[subject", [nested])).toEqual([
            "=",
            "==",
            "!=",
            "+=",
            "-=",
        ]);
        for (const path of [
            "subject[0]",
            "subject[i]",
            "subject.hair",
            "subject[].hair",
        ]) {
            expect(labels(`portraits[${path}`, [nested])).toEqual([
                "=",
                "==",
                "!=",
            ]);
        }
        expect(labels("portraits[subject[i].hair", [nested])).toContain("+=");
        expect(labels("portraits[subject[]", [nested])).toContain("+=");
    });
    it("suggests the current all-record syntax when completing the compatibility alias", () => {
        expect(labels("portraits:subject[*].h", [nested])).toEqual([
            "subject[].hair",
        ]);
        expect(
            computeQuarryCompletions("portraits[subject[*]", [nested])[0].apply,
        ).toBe("<q:portraits[subject[]=");
        expect(labels("portraits:", [nested])).toContain("subject[]");
        expect(labels("portraits:", [nested])).not.toContain("subject[*]");
    });
    it("completes output selectors without interpreting them as a new filter", () => {
        const result = computeQuarryCompletions(
            "portraits[subject[i].hair=blond]:subject[i].e",
            [nested],
        );
        expect(result[0].apply).toBe(
            "<q:portraits[subject[i].hair=blond]:subject[i].eyes",
        );
        expect(labels("portraits:subject[].h", [nested])).toEqual([
            "subject[].hair",
        ]);
    });
    it("preserves binding case while matching column and field names without case", () => {
        expect(labels("portraits[SUBJECT[Person].H", [nested])).toEqual([
            "subject[Person].hair",
        ]);
        expect(
            computeQuarryCompletions("portraits[SUBJECT[I].HAIR", [nested])[0]
                .apply,
        ).toBe("<q:portraits[subject[I].hair=");
        expect(
            computeQuarryCompletions(
                "portraits[subject[I].hair=blond]:SUBJECT[I].H",
                [nested],
            )[0].apply,
        ).toBe("<q:portraits[subject[I].hair=blond]:subject[I].hair");
    });
    it("keeps bindings differing only in case distinct in output suggestions", () => {
        const query = "portraits[subject[I].hair=blond;subject[i].hair=red]:";
        expect(labels(query, [nested])).toEqual(
            expect.arrayContaining(["subject[I]", "subject[i]"]),
        );
        expect(labels(`${query}SUBJECT[I],`, [nested])).not.toContain(
            "subject[I]",
        );
        expect(labels(`${query}SUBJECT[I],`, [nested])).toContain("subject[i]");
        expect(labels(`${query}subject[i].H`, [nested])).toEqual([
            "subject[i].hair",
        ]);
    });
    it("offers formatting names and aliases while respecting quoted separators", () => {
        expect(
            labels('portraits:subject[]|keys;rs="; [] |"; f', [nested]),
        ).toEqual(['field_separator="', 'fs="']);
        expect(labels('portraits:subject[]|rs=";', [nested])).toEqual([]);
    });
});

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
        expect(labels("characters[")).toEqual([
            "tags",
            "prompt",
            "source",
            "tags[]",
        ]);
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
        expect(labels("characters[ta")).toEqual(["tags", "tags[]"]);
    });

    it("suggests content and count operators for an array column", () => {
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
            {
                apply: "<q:characters[tags+=",
                label: "+=",
                hint: "at least (number, text length, or array count)",
            },
            {
                apply: "<q:characters[tags-=",
                label: "-=",
                hint: "at most (number, text length, or array count)",
            },
        ]);
    });

    it("offers operators for a complete column in a later clause too", () => {
        expect(labels("characters[source")).toEqual([
            "=",
            "==",
            "!=",
            "+=",
            "-=",
        ]);
        expect(
            computeQuarryCompletions("characters[tags=girl;source", ALL)[0],
        ).toEqual({
            apply: "<q:characters[tags=girl;source=",
            label: "=",
            hint: "match any of the values",
        });
    });

    it("adds `+=` and `-=` for numeric and text scalar columns", () => {
        const rated: CompletionDataset = {
            name: "rated",
            columns: [
                { name: "prompt", kind: "scalar" },
                { name: "score", kind: "scalar", numeric: true },
            ],
            tagColumns: [],
            promptColumn: "prompt",
            rowCount: 10,
        };
        // A numeric column offers the comparison operators on top of the text ones...
        expect(computeQuarryCompletions("rated[score", [rated])).toEqual([
            {
                apply: "<q:rated[score=",
                label: "=",
                hint: "match any of the values",
            },
            {
                apply: "<q:rated[score==",
                label: "==",
                hint: "match all of the values",
            },
            {
                apply: "<q:rated[score!=",
                label: "!=",
                hint: "match none of the values",
            },
            {
                apply: "<q:rated[score+=",
                label: "+=",
                hint: "at least (number, text length, or array count)",
            },
            {
                apply: "<q:rated[score-=",
                label: "-=",
                hint: "at most (number, text length, or array count)",
            },
        ]);
        // A text column uses the same operators for character-count comparisons.
        expect(
            computeQuarryCompletions("rated[prompt", [rated]).map(
                (c) => c.label,
            ),
        ).toEqual(["=", "==", "!=", "+=", "-="]);
    });

    it("does not add comparison modifiers for direct objects", () => {
        const objects: CompletionDataset = {
            ...ALL[0],
            columns: [
                { name: "meta", kind: "object", fields: [{ name: "mood" }] },
            ],
        };
        expect(labels(`${objects.name}[meta`, [objects])).toEqual([
            "=",
            "==",
            "!=",
        ]);
    });

    it("stops suggesting columns once a `+=` / `-=` is typed", () => {
        const rated: CompletionDataset = {
            name: "rated",
            columns: [{ name: "score", kind: "scalar", numeric: true }],
            tagColumns: [],
            promptColumn: "score",
            rowCount: 10,
        };
        expect(computeQuarryCompletions("rated[score+=0", [rated])).toEqual([]);
        expect(computeQuarryCompletions("rated[score-=7", [rated])).toEqual([]);
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
    it("offers unselected columns after each comma, ignoring case and spaces", () => {
        expect(labels("characters: PROMPT ,")).toEqual([
            "tags",
            "source",
            "tags[]",
        ]);
        expect(labels("characters:prompt, tags,")).toEqual(["source"]);
        expect(labels("characters:prompt, tags[],")).toEqual(["source"]);
        expect(labels("characters:prompt,tags,source,")).toEqual([]);
    });

    it("completes the current column while preserving datasets, filters, and prior columns", () => {
        expect(
            computeQuarryCompletions(
                "characters,creatures[source=http://x;tags=goth,punk]:prompt,caption, so",
                ALL,
            ),
        ).toEqual([
            {
                apply: "<q:characters,creatures[source=http://x;tags=goth,punk]:prompt,caption,source",
                label: "source",
                hint: "column",
            },
        ]);
    });

    it("lists the columns usable as the prompt after `:`, the default first", () => {
        expect(labels("characters:")).toEqual([
            "prompt",
            "tags",
            "source",
            "tags[]",
        ]);
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
            "tags[]",
        ]);
        expect(labels("characters[tags=girl]:")).toEqual([
            "prompt",
            "tags",
            "source",
            "tags[]",
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
            "tags[]",
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
