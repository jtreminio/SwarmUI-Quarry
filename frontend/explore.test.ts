import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
} from "@jest/globals";
import { buildExploreQuery, DatasetExplorer } from "./explore";
import type {
    DatasetDto,
    ExploreColumnResponse,
    RunQueryResponse,
} from "./types";

const dataset: DatasetDto = {
    name: "tags/example",
    columns: [
        { name: "rating", kind: "scalar" },
        { name: "artist", kind: "scalar" },
        { name: "score", kind: "scalar", numeric: true },
        { name: "prompt", kind: "scalar" },
        {
            name: "subject",
            kind: "object",
            fields: [{ name: "hair" }, { name: "age", numeric: true }],
        },
    ],
    resolvedPromptColumn: "prompt",
    configuredPromptColumn: null,
    configuredTagColumns: [],
    rowCount: 1000000,
    error: null,
};
const originalRequest = globalThis.genericRequest;
const globals = globalThis as typeof globalThis & {
    uiImprover: typeof uiImprover;
};
const originalImprover = globals.uiImprover;
const originalChange = globalThis.triggerChangeFor;
const artists = [
    "ann",
    "joanne",
    ...Array.from(
        { length: 130 },
        (_, i) => `artist_${i.toString().padStart(3, "0")}`,
    ),
];
const columnRequest = <T>(
    name: string,
    data: Record<string, unknown>,
    callback: (data: T) => void,
): void => {
    if (name !== "QuarryExploreColumn") return;
    const all =
        data.column === "rating"
            ? ["g", "s", "q", "e"]
            : data.column === "artist"
              ? artists
              : [];
    const matches = all.filter((value) =>
        value.toLowerCase().includes(String(data.search ?? "").toLowerCase()),
    );
    const offset = Number(data.offset ?? 0);
    callback({
        success: true,
        eligible: all.length > 0,
        reason: all.length ? "" : "length_limit",
        revision: "v1",
        uniqueLimit: 10000,
        lengthLimit: 256,
        maxDistinctPercent: 10,
        totalValues: all.length,
        matchingValues: matches.length,
        values: matches.slice(offset, offset + 100),
        offset,
        hasMore: offset + 100 < matches.length,
    } as T);
};
beforeEach(() => {
    jest.useFakeTimers();
    globalThis.genericRequest = columnRequest;
});
afterEach(() => {
    jest.useRealTimers();
    document.body.replaceChildren();
    globalThis.genericRequest = originalRequest;
    globals.uiImprover = originalImprover;
    globalThis.triggerChangeFor = originalChange;
});
const setup = (catalog: DatasetDto[] = [dataset]) => {
    const host = document.createElement("div");
    document.body.append(host);
    const close = jest.fn(),
        sample = jest.fn(),
        source = jest.fn();
    const explorer = new DatasetExplorer(
        host,
        dataset,
        () => "Sample table",
        close,
        sample,
        () => {},
        catalog,
        source,
    );
    explorer.setRows(
        ["rating", "artist", "score", "prompt"],
        [
            ["g", "ann", "10", "A portrait"],
            ["s", "joanne", "100", "A landscape"],
        ],
    );
    const get = <T extends HTMLElement = HTMLElement>(selector: string): T => {
        const element = host.querySelector<T>(selector);
        if (!element) throw new Error(`Missing ${selector}`);
        return element;
    };
    const click = (selector: string) =>
        get<HTMLButtonElement>(selector).click();
    const edit = (selector: string, value: string, event = "input") => {
        const input = get<HTMLInputElement>(selector);
        input.value = value;
        input.dispatchEvent(new Event(event, { bubbles: true }));
        jest.advanceTimersByTime(250);
    };
    const field = (value: string, row = 0) =>
        edit(`[data-row="${row}"] .quarry-explore-column`, value, "change");
    const value = (text: string, row = 0) =>
        edit(`[data-row="${row}"] .quarry-explore-value`, text);
    const operator = (text: string, row = 0) =>
        edit(`[data-row="${row}"] .quarry-explore-operator`, text, "change");
    const output = (text: string) =>
        edit(".quarry-explore-output-add", text, "change");
    const coreEdit = (selector: string, value: string) => {
        const input = get<HTMLInputElement>(selector);
        input.value = value;
        // SwarmUI's custom dropdowns use triggerChangeFor, whose events do not bubble.
        input.dispatchEvent(new Event("input"));
        input.dispatchEvent(new Event("change"));
        jest.advanceTimersByTime(250);
    };
    const query = () => get(".quarry-explore-query").textContent;
    return {
        host,
        explorer,
        close,
        sample,
        source,
        get,
        click,
        edit,
        field,
        value,
        operator,
        output,
        coreEdit,
        query,
    };
};

describe("Editable Explore filters", () => {
    it("updates discovery and filters from SwarmUI's non-bubbling dropdown events", () => {
        const { coreEdit, query, get, host } = setup();
        coreEdit(".quarry-explore-column", "artist");
        expect(get(".quarry-explore-field").textContent).toContain("artist");
        expect(host.querySelector('[data-value="ann"]')).not.toBeNull();
        expect(host.querySelector('[data-value="g"]')).toBeNull();
        coreEdit(".quarry-explore-value", "ann");
        coreEdit(".quarry-explore-operator", "!=");
        expect(query()).toBe("<q:tags/example[artist!=ann]>");
        coreEdit(".quarry-explore-column", "score");
        expect(get<HTMLInputElement>(".quarry-explore-value").type).toBe(
            "number",
        );
        coreEdit(".quarry-explore-value", "100");
        expect(query()).toBe("<q:tags/example[score+=100]>");
    });
    it("handles non-bubbling output changes and removes those handlers on disposal", () => {
        const { coreEdit, explorer, query, get } = setup();
        coreEdit(".quarry-explore-output-add", "subject.hair");
        expect(query()).toBe("<q:tags/example:subject.hair>");
        expect(get<HTMLSelectElement>(".quarry-explore-output-add").value).toBe(
            "",
        );
        explorer.dispose();
        coreEdit(".quarry-explore-output-add", "artist");
        expect(query()).toBe("<q:tags/example:subject.hair>");
    });
    it("updates repeating rows immediately, including negatives and numeric bounds", () => {
        const { click, field, value, operator, query } = setup();
        click('[data-value="g"]');
        click('[data-value="s"]');
        click('[data-action="add"]');
        field("artist", 1);
        value("ann", 1);
        click('[data-action="add"]');
        value("joanne", 2);
        operator("!=", 2);
        click('[data-action="add"]');
        field("score", 3);
        value("100", 3);
        expect(query()).toBe(
            "<q:tags/example[rating=g,s;artist=ann;artist!=joanne;score+=100]>",
        );
        value("200", 3);
        click('[data-remove="1"]');
        expect(query()).toBe(
            "<q:tags/example[rating=g,s;artist!=joanne;score+=200]>",
        );
    });
    it("targets suggestions at the focused row and keeps blank rows out of queries", () => {
        const { get, click, query, host, value } = setup();
        click('[data-value="g"]');
        click('[data-action="add"]');
        click('[data-value="s"]');
        get<HTMLInputElement>('[data-row="0"] input').focus();
        click('[data-value="q"]');
        expect(query()).toBe("<q:tags/example[rating=g,q;rating=s]>");
        click('[data-action="add"]');
        expect(query()).not.toContain(";rating=]>");
        click('[data-remove="2"]');
        click('[data-remove="1"]');
        expect(get('[data-remove="0"]').hidden).toBe(true);
        value("");
        expect(host.querySelectorAll("[data-row]")).toHaveLength(1);
        expect(query()).toBe("<q:tags/example>");
    });
    it("preserves filters and output while samples change and requests fresh rows on every rows click", () => {
        const { explorer, click, value, output, query, sample, get } = setup();
        value("g");
        output("artist");
        explorer.setRows(["rating"], [["q"]]);
        expect(get<HTMLInputElement>(".quarry-explore-value").value).toBe("g");
        click('[data-view="rows"]');
        click('[data-view="fields"]');
        click('[data-view="rows"]');
        expect(sample).toHaveBeenCalledTimes(2);
        expect(query()).toBe("<q:tags/example[rating=g]:artist>");
    });
    it("blocks invalid terms and does not expose examples for free text", () => {
        const { value, get, explorer, field, host } = setup();
        value("g;score+=0");
        expect(get<HTMLButtonElement>('[data-action="test"]').disabled).toBe(
            true,
        );
        expect(get(".quarry-explore-error").textContent).toContain(
            "query separators",
        );
        field("prompt");
        explorer.setRows(["prompt"], [['<img src=x onerror="alert(1)">']]);
        expect(host.querySelector("img")).toBeNull();
        expect(
            host.querySelector<HTMLElement>('[data-values-row="0"]')?.hidden,
        ).toBe(true);
    });
    it("supports numeric nested fields without misclassifying them as text", () => {
        const { field, value, query, get } = setup();
        field("subject.age");
        value("18");
        expect(get<HTMLSelectElement>(".quarry-explore-operator").value).toBe(
            "+=",
        );
        expect(query()).toBe("<q:tags/example[subject.age+=18]>");
    });
});

describe("Output selection and formatting", () => {
    it("preserves root and nested output order with field names and quoted separators", () => {
        const { output, get, edit, query, click } = setup();
        output("prompt");
        output("subject.hair");
        output("artist");
        const keys = get<HTMLInputElement>(".quarry-explore-keys");
        keys.checked = true;
        keys.dispatchEvent(new Event("change", { bubbles: true }));
        edit(".quarry-explore-record-separator", "\n");
        edit(".quarry-explore-field-separator", '" | ');
        expect(query()).toBe(
            '<q:tags/example:prompt,subject.hair,artist|keys;rs="\\n";fs="\\" | ">',
        );
        click('[data-remove-output="1"]');
        expect(query()).toContain(":prompt,artist|");
        click('[data-remove-output="1"]');
        click('[data-remove-output="0"]');
        expect(query()).toContain("example|keys");
        expect(get(".quarry-explore-output-selected").textContent).toContain(
            "Dataset default: prompt",
        );
    });
    it("escapes tag delimiters in literal formatting strings", () => {
        expect(
            buildExploreQuery("test", [], ["prompt"], {
                recordSeparator: ">",
                fieldSeparator: "<",
            }),
        ).toBe('<q:test:prompt|rs="\\u003e";fs="\\u003c">');
    });
    it("uses the same full query for tests and insertion", () => {
        const { click, output, close, value, query } = setup();
        output("subject.hair");
        value("g");
        const queries: string[] = [];
        globalThis.genericRequest = <T>(
            _name: string,
            data: Record<string, unknown>,
            callback: (data: T) => void,
        ): void => {
            queries.push(String(data.query));
            callback({ total: 0, results: [] } as T);
        };
        click('[data-action="test"]');
        click('[data-action="test"]');
        expect(queries).toEqual([query(), query()]);
        const prompt = document.createElement("textarea");
        prompt.value = "photo <q:other>";
        globals.uiImprover = {
            getLastSelectedTextbox: () => [prompt, prompt.value.length],
        };
        globalThis.triggerChangeFor = jest.fn();
        click('[data-action="use"]');
        expect(prompt.value).toBe(`photo <q:other> ${query()}`);
        expect(close).toHaveBeenCalled();
    });
    it("ignores old test responses after filter or output edits and after disposal", () => {
        const pending: ((data: RunQueryResponse) => void)[] = [];
        globalThis.genericRequest = <T>(
            name: string,
            data: Record<string, unknown>,
            callback: (data: T) => void,
        ): void => {
            if (name === "QuarryExploreColumn")
                columnRequest(name, data, callback);
            else pending.push(callback as (data: RunQueryResponse) => void);
        };
        const { click, output, host, explorer } = setup();
        click('[data-action="test"]');
        output("artist");
        pending[0]({ error: "old response" });
        expect(host.textContent).not.toContain("old response");
        click('[data-action="test"]');
        explorer.dispose();
        pending[1]({ error: "closed response" });
        expect(host.textContent).not.toContain("closed response");
    });
});

describe("Verified value pickers", () => {
    it("pages and searches values beyond the first page, accepting manual terms", () => {
        const { host, field, click, edit, value, query } = setup();
        field("artist");
        expect(host.querySelectorAll("[data-value]")).toHaveLength(100);
        click('[data-action="more-values"]');
        expect(host.querySelectorAll("[data-value]")).toHaveLength(132);
        edit(".quarry-explore-search", "ARTIST_129");
        expect(host.querySelectorAll("[data-value]")).toHaveLength(1);
        expect(host.textContent).toContain("artist_129");
        edit(".quarry-explore-search", "unknown");
        expect(host.textContent).toContain("No matching values.");
        value("unseen_artist");
        expect(query()).toContain("artist=unseen_artist");
    });
    it("does not infer recurring values from duplicate sample rows", () => {
        const { host, explorer, field } = setup();
        field("prompt");
        explorer.setRows(["prompt"], [["short"], ["short"]]);
        expect(host.querySelectorAll("[data-value]")).toHaveLength(0);
        expect(host.textContent).toContain("at least 256 characters");
    });
    it("ignores stale column responses and responses after closing", () => {
        const pending: ((data: ExploreColumnResponse) => void)[] = [];
        globalThis.genericRequest = <T>(
            _name: string,
            _data: object,
            callback: (data: T) => void,
        ): void => {
            pending.push(callback as (data: ExploreColumnResponse) => void);
        };
        const { host, field, explorer } = setup();
        field("artist");
        pending[0]({ success: true, eligible: true, values: ["stale"] });
        expect(host.textContent).not.toContain("stale");
        explorer.dispose();
        pending[1]({ success: true, eligible: true, values: ["closed"] });
        expect(host.textContent).not.toContain("closed");
    });
    it("discards pages from an older dataset revision", () => {
        const { host, field, click } = setup();
        field("artist");
        globalThis.genericRequest = <T>(
            name: string,
            data: Record<string, unknown>,
            callback: (data: T) => void,
        ): void => {
            columnRequest(name, data, (response: ExploreColumnResponse) =>
                callback({
                    ...response,
                    revision: "v2",
                    values: data.offset ? ["old offset"] : ["fresh first page"],
                    hasMore: false,
                } as T),
            );
        };
        click('[data-action="more-values"]');
        expect(host.querySelectorAll("[data-value]")).toHaveLength(1);
        expect(host.textContent).toContain("fresh first page");
        expect(host.textContent).not.toContain("old offset");
    });
    it("keeps manual filters usable after check errors and retries", () => {
        globalThis.genericRequest = <T>(
            _name: string,
            _data: object,
            callback: (data: T) => void,
        ): void => callback({ success: false, error: "Scan failed" } as T);
        const { host, value, query, click } = setup();
        expect(host.textContent).toContain("Scan failed");
        value("g");
        expect(query()).toContain("rating=g");
        globalThis.genericRequest = columnRequest;
        click('[data-action="retry-values"]');
        expect(host.querySelector('[data-value="g"]')).not.toBeNull();
    });
});

describe("Explore dataset selection and presentation", () => {
    const second: DatasetDto = { ...dataset, name: "nl/second" };
    const missing: DatasetDto = {
        ...dataset,
        name: "nl/missing",
        columns: [{ name: "prompt", kind: "scalar" }],
    };
    const numeric: DatasetDto = {
        ...dataset,
        name: "nl/numeric",
        columns: [{ name: "rating", kind: "scalar", numeric: true }],
    };
    it("adds compatible datasets while keeping filters, nested outputs, and flags", () => {
        const { click, value, output, get, query, source } = setup([
            dataset,
            second,
        ]);
        value("g");
        output("subject.hair");
        const keys = get<HTMLInputElement>(".quarry-explore-keys");
        keys.checked = true;
        keys.dispatchEvent(new Event("change", { bubbles: true }));
        click(".quarry-explore-query-dataset");
        click('[data-add-dataset="nl/second"]');
        expect(query()).toBe(
            "<q:tags/example,nl/second[rating=g]:subject.hair|keys>",
        );
        expect(source).toHaveBeenLastCalledWith(dataset, [
            dataset.name,
            second.name,
        ]);
        click('[data-remove-dataset="tags/example"]');
        expect(query()).toBe("<q:nl/second[rating=g]:subject.hair|keys>");
        expect(source).toHaveBeenLastCalledWith(second, [second.name]);
    });
    it("explains missing and incompatible fields but still permits switching", () => {
        const { click, value, get, query, host } = setup([
            dataset,
            missing,
            numeric,
        ]);
        value("g");
        click(".quarry-explore-query-dataset");
        expect(
            get<HTMLButtonElement>('[data-add-dataset="nl/missing"]').disabled,
        ).toBe(true);
        expect(
            get<HTMLButtonElement>('[data-add-dataset="nl/numeric"]').disabled,
        ).toBe(true);
        expect(host.textContent).toContain("Missing field: rating");
        expect(host.textContent).toContain("Different field type: rating");
        click('[data-switch-dataset="nl/missing"]');
        expect(query()).toBe("<q:nl/missing>");
        expect(get<HTMLSelectElement>(".quarry-explore-column").value).toBe(
            "prompt",
        );
    });
    it("switching resets output flags and discards responses for the previous query", () => {
        const pending: ((data: RunQueryResponse) => void)[] = [];
        globalThis.genericRequest = <T>(
            name: string,
            data: Record<string, unknown>,
            callback: (data: T) => void,
        ): void => {
            if (name === "QuarryRunQuery")
                pending.push(callback as (data: RunQueryResponse) => void);
            else columnRequest(name, data, callback);
        };
        const { click, value, output, get, query } = setup([dataset, second]);
        value("g");
        output("artist");
        const keys = get<HTMLInputElement>(".quarry-explore-keys");
        keys.checked = true;
        keys.dispatchEvent(new Event("change", { bubbles: true }));
        click('[data-action="test"]');
        click(".quarry-explore-query-dataset");
        click('[data-switch-dataset="nl/second"]');
        expect(query()).toBe("<q:nl/second>");
        expect(keys.checked).toBe(false);
        pending[0]({ error: "stale query" });
        expect(get(".quarry-explore-results").textContent).not.toContain(
            "stale query",
        );
        pending[1]({ error: "current query" });
        expect(get(".quarry-explore-results").textContent).toContain(
            "current query",
        );
    });
    it("changes browsing source without changing the combined query", () => {
        const { click, coreEdit, query, source, get } = setup([
            dataset,
            missing,
        ]);
        click(".quarry-explore-query-dataset");
        click('[data-add-dataset="nl/missing"]');
        expect(
            Array.from(
                get<HTMLSelectElement>(".quarry-explore-column").options,
                (option) => option.value,
            ),
        ).toEqual(["prompt"]);
        const before = query();
        coreEdit(".quarry-explore-source select", missing.name);
        expect(query()).toBe(before);
        expect(source).toHaveBeenLastCalledWith(missing, [
            dataset.name,
            missing.name,
        ]);
    });
    it("summarizes matching results and copies the rendered prompt", () => {
        globalThis.genericRequest = <T>(
            name: string,
            data: Record<string, unknown>,
            callback: (data: T) => void,
        ): void => {
            if (name === "QuarryRunQuery")
                callback({
                    total: 7456,
                    datasets: [{ name: dataset.name, matches: 7456 }],
                    results: [{ dataset: dataset.name, prompt: "Portrait" }],
                } as T);
            else columnRequest(name, data, callback);
        };
        const { click, get } = setup();
        click('[data-action="test"]');
        expect(get(".quarry-explore-result-summary").textContent).toContain(
            "1 random result · 7,456 matches",
        );
        const copy = globalThis.copyText,
            notice = globalThis.doNoticePopover;
        try {
            globalThis.copyText = jest.fn();
            globalThis.doNoticePopover = jest.fn();
            click(".quarry-runquery-copy");
            expect(globalThis.copyText).toHaveBeenCalledWith("Portrait");
            expect(globalThis.doNoticePopover).toHaveBeenCalledWith(
                "Copied!",
                "notice-pop-green quarry-copy-notice",
            );
        } finally {
            globalThis.copyText = copy;
            globalThis.doNoticePopover = notice;
        }
    });
    it("keeps chooser buttons attached when search loses focus", () => {
        const { click, edit, get, query } = setup([dataset, second]);
        click(".quarry-explore-manage");
        edit(".quarry-explore-dataset-search", "second");
        const button = get<HTMLButtonElement>(
            '[data-switch-dataset="nl/second"]',
        );
        edit(".quarry-explore-dataset-search", "second", "change");
        expect(button.isConnected).toBe(true);
        button.click();
        expect(query()).toBe("<q:nl/second>");
    });
    it("supports keyboard tabs and closes the chooser without closing Explore", () => {
        const { click, get, sample, close } = setup();
        get('[data-view="fields"]').dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        );
        expect(get('[data-view="rows"]').getAttribute("aria-selected")).toBe(
            "true",
        );
        expect(sample).toHaveBeenCalledTimes(1);
        click(".quarry-explore-manage");
        get(".quarry-explore-dataset-search").dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
        expect(get(".quarry-explore-dataset-picker").hidden).toBe(true);
        expect(close).not.toHaveBeenCalled();
    });
});

describe("Explore compact controls", () => {
    it("preserves results through filter edits and distinguishes effective query changes", () => {
        globalThis.genericRequest = <T>(
            name: string,
            data: Record<string, unknown>,
            callback: (data: T) => void,
        ): void => {
            if (name === "QuarryRunQuery")
                callback({
                    total: 1,
                    results: [
                        { dataset: dataset.name, prompt: "Keep this result" },
                    ],
                } as T);
            else columnRequest(name, data, callback);
        };
        const { click, value, get } = setup();
        click('[data-action="test"]');
        const row = get(".quarry-explore-results tbody tr");
        click('[data-action="add"]');
        expect(get(".quarry-explore-results tbody tr")).toBe(row);
        expect(get(".quarry-explore-result-status").textContent).toBe("");
        value("g", 1);
        expect(get(".quarry-explore-results tbody tr")).toBe(row);
        expect(get(".quarry-explore-result-status").textContent).toContain(
            "last test",
        );
        click('[data-remove="1"]');
        expect(get(".quarry-explore-results tbody tr")).toBe(row);
        expect(get(".quarry-explore-result-status").textContent).toBe("");
    });
    it("accepts an in-flight sample after adding a blank filter", () => {
        let complete: ((data: RunQueryResponse) => void) | undefined;
        globalThis.genericRequest = <T>(
            name: string,
            data: Record<string, unknown>,
            callback: (data: T) => void,
        ): void => {
            if (name === "QuarryRunQuery")
                complete = callback as (data: RunQueryResponse) => void;
            else columnRequest(name, data, callback);
        };
        const { click, get } = setup();
        click('[data-action="test"]');
        click('[data-action="add"]');
        complete?.({
            total: 1,
            results: [{ dataset: dataset.name, prompt: "Initial sample" }],
        });
        expect(get(".quarry-explore-results").textContent).toContain(
            "Initial sample",
        );
    });
    it("places removable reorderable output tags in the query without polluting copied text", () => {
        const { output, query, get, click, value } = setup();
        value("foo:prompt");
        output("prompt");
        output("artist");
        output("subject.hair");
        expect(query()).toBe(
            "<q:tags/example[rating=foo:prompt]:prompt,artist,subject.hair>",
        );
        get('[data-output-index="2"]').dispatchEvent(
            new KeyboardEvent("keydown", {
                key: "ArrowLeft",
                altKey: true,
                bubbles: true,
            }),
        );
        expect(query()).toContain(":prompt,subject.hair,artist>");
        get('[data-output-index="1"]').dispatchEvent(
            new KeyboardEvent("keydown", {
                key: "ArrowLeft",
                altKey: true,
                bubbles: true,
            }),
        );
        expect(query()).toContain(":subject.hair,prompt,artist>");
        click('[data-remove-output="0"]');
        expect(query()).toContain(":prompt,artist>");
    });
    it("shows all matching datasets", () => {
        const { click, host } = setup(
            Array.from({ length: 131 }, (_, i) => ({
                ...dataset,
                name: `dataset-${i}`,
            })),
        );
        click(".quarry-explore-manage");
        expect(host.querySelectorAll("[data-switch-dataset]")).toHaveLength(
            131,
        );
    });
    it("toggles verified values and expands formatting inline", () => {
        const { click, get, field } = setup();
        field("rating");
        click('[data-values-row="0"]');
        expect(get(".quarry-explore-field").hidden).toBe(false);
        click('[data-values-row="0"]');
        expect(get(".quarry-explore-field").hidden).toBe(true);
        click('[data-values-row="0"]');
        get('[data-action="close-values"]').dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
        expect(get(".quarry-explore-field").hidden).toBe(true);
        click('[data-values-row="0"]');
        click('[data-action="format"]');
        expect(get(".quarry-explore-field").hidden).toBe(true);
        expect(get(".quarry-explore-format-panel").hidden).toBe(false);
        click('[data-action="format"]');
        expect(get(".quarry-explore-format-panel").hidden).toBe(true);
    });
});

describe("Text length and stable recurring controls", () => {
    it("uses existing length comparisons with whole character counts", () => {
        const { field, operator, value, query, get } = setup();
        field("prompt");
        operator("+=");
        value("80");
        expect(query()).toBe("<q:tags/example[prompt+=80]>");
        expect(get<HTMLInputElement>(".quarry-explore-value").type).toBe(
            "number",
        );
        value("-1");
        expect(get<HTMLButtonElement>('[data-action="test"]').disabled).toBe(
            true,
        );
        value("1.5");
        expect(get<HTMLButtonElement>('[data-action="test"]').disabled).toBe(
            true,
        );
        value("0");
        expect(get<HTMLButtonElement>('[data-action="test"]').disabled).toBe(
            false,
        );
        operator("-=");
        expect(query()).toBe("<q:tags/example[prompt-=0]>");
        operator("=");
        value("portrait");
        expect(query()).toBe("<q:tags/example[prompt=portrait]>");
    });
    it("keeps recurring buttons stable across filter focus and hides them for free text", () => {
        const { click, field, get } = setup();
        expect(get('[data-values-row="0"]').textContent).toBe("Choose values");
        click('[data-action="add"]');
        expect(get('[data-values-row="0"]').hidden).toBe(false);
        expect(get('[data-values-row="0"]').textContent).toBe("Choose values");
        field("prompt", 1);
        click('[data-action="add"]');
        expect(get('[data-values-row="1"]').hidden).toBe(true);
        expect(get('[data-values-row="2"]').hidden).toBe(true);
        expect(get('[data-values-row="0"]').textContent).toBe("Choose values");
    });
});

describe("Explore output selection and drop positions", () => {
    it("removes selected columns from choices and restores deleted columns", () => {
        const { output, click, get } = setup();
        output("prompt");
        output("subject.hair");
        const options = () =>
            Array.from(
                get<HTMLSelectElement>(".quarry-explore-output-add").options,
                (option) => option.value,
            );
        expect(options()).not.toContain("prompt");
        expect(options()).not.toContain("subject.hair");
        click('[data-remove-output="0"]');
        expect(options()).toContain("prompt");
        expect(options()).not.toContain("subject.hair");
    });
    it("marks the insertion edge and drops before or after the target", () => {
        const { output, get, query } = setup();
        output("prompt");
        output("artist");
        output("rating");
        const drag = (
            kind: string,
            source: number,
            target: number,
            x: number,
        ) => {
            const token = get(`[data-output-index="${target}"]`);
            token.getBoundingClientRect = () =>
                ({ left: 100, width: 100 }) as DOMRect;
            const event = new Event(kind, { bubbles: true, cancelable: true });
            Object.assign(event, {
                clientX: x,
                dataTransfer: {
                    types: ["application/x-quarry-output"],
                    getData: () => String(source),
                },
            });
            token.dispatchEvent(event);
        };
        drag("dragover", 0, 2, 190);
        expect(get('[data-output-index="2"]').dataset.dropEdge).toBe("after");
        drag("drop", 0, 2, 190);
        expect(query()).toContain(":artist,rating,prompt>");
        drag("dragover", 2, 0, 110);
        expect(get('[data-output-index="0"]').dataset.dropEdge).toBe("before");
        drag("drop", 2, 0, 110);
        expect(query()).toContain(":prompt,artist,rating>");
        expect(
            get(".quarry-explore-query").querySelector("[data-drop-edge]"),
        ).toBeNull();
    });
    it("groups selected datasets first and prevents adding them twice", () => {
        const other = { ...dataset, name: "nl/first" };
        const { click, get, host } = setup([other, dataset]);
        click(".quarry-explore-manage");
        expect(
            get(".quarry-explore-dataset-option").classList.contains(
                "is-selected",
            ),
        ).toBe(true);
        expect(get(".quarry-explore-selected-label").textContent).toContain(
            "Selected",
        );
        expect(
            host.querySelector('[data-add-dataset="tags/example"]'),
        ).toBeNull();
    });
});

it("Escape closes inline formatting, and Back to query restores the query view", () => {
    const { click, get } = setup();
    click('[data-action="format"]');
    get(".quarry-explore-record-separator").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(get(".quarry-explore-format-panel").hidden).toBe(true);
    expect(get('[data-action="format"]').getAttribute("aria-expanded")).toBe(
        "false",
    );
    click('[data-view="rows"]');
    click(".quarry-explore-manage");
    click('[data-action="close-datasets"]');
    expect(get(".quarry-explore-fields-view").hidden).toBe(false);
    expect(get(".quarry-explore-rows-view").hidden).toBe(true);
});

it("refreshes preview and rejects an old response when saved defaults change", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const pending: ((data: RunQueryResponse) => void)[] = [];
    let saved: ((data: DatasetDto) => void) | undefined;
    globalThis.genericRequest = <T>(
        name: string,
        _data: object,
        callback: (data: T) => void,
    ): void => {
        if (name === "QuarryRunQuery")
            pending.push(callback as (data: RunQueryResponse) => void);
    };
    const explorer = new DatasetExplorer(
        host,
        { ...dataset },
        () => "",
        () => {},
        () => {},
        () => {},
        [dataset],
        () => {},
        (_host, _dataset, onSaved) => {
            saved = onSaved;
            return () => {};
        },
    );
    explorer.testQuery();
    saved?.({
        ...dataset,
        configuredPromptColumn: "artist",
        resolvedPromptColumn: "artist",
    });
    expect(pending).toHaveLength(2);
    pending[0]({ error: "outdated default" });
    expect(
        host.querySelector(".quarry-explore-results")?.textContent,
    ).not.toContain("outdated default");
    pending[1]({
        results: [{ dataset: dataset.name, prompt: "new artist output" }],
        total: 1,
    });
    expect(
        host.querySelector(".quarry-explore-results")?.textContent,
    ).toContain("new artist output");
    explorer.dispose();
});

it("clears all filters while keeping output choices and the last results", () => {
    const { click, value, output, query, get, host, explorer } = setup();
    globalThis.genericRequest = <T>(
        name: string,
        _data: object,
        callback: (data: T) => void,
    ): void => {
        if (name === "QuarryRunQuery")
            callback({
                results: [{ dataset: dataset.name, prompt: "kept preview" }],
                total: 1,
            } as T);
    };
    value("g");
    output("artist");
    click('[data-action="add"]');
    value("ann", 1);
    explorer.testQuery();
    click('[data-action="clear-filters"]');
    expect(query()).toBe("<q:tags/example:artist>");
    expect(host.querySelectorAll("[data-row]")).toHaveLength(1);
    expect(get<HTMLInputElement>(".quarry-explore-value").value).toBe("");
    expect(get(".quarry-explore-results").textContent).toContain(
        "kept preview",
    );
    expect(get(".quarry-explore-result-status").textContent).toContain(
        "last test",
    );
});

it("shows saved dataset settings in a separate tab with keyboard navigation", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const explorer = new DatasetExplorer(
        host,
        dataset,
        () => "",
        () => {},
        () => {},
        () => {},
        [dataset],
        () => {},
        (container) => {
            container.textContent = "Settings form";
            return () => {};
        },
    );
    const tab = host.querySelector<HTMLButtonElement>('[data-view="settings"]');
    tab?.click();
    expect(
        host.querySelector<HTMLElement>(".quarry-explore-settings-view")
            ?.hidden,
    ).toBe(false);
    expect(
        host.querySelector<HTMLElement>(".quarry-explore-fields-view")?.hidden,
    ).toBe(true);
    expect(
        host.querySelector<HTMLElement>(".quarry-explore-rows-view")?.hidden,
    ).toBe(true);
    tab?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    expect(
        host.querySelector('[data-view="rows"]')?.getAttribute("aria-selected"),
    ).toBe("true");
    host.querySelector<HTMLButtonElement>(".quarry-explore-manage")?.click();
    expect(
        host
            .querySelector(".quarry-explore-manage")
            ?.getAttribute("aria-expanded"),
    ).toBe("true");
    host.querySelector<HTMLButtonElement>(
        '[data-action="close-datasets"]',
    )?.click();
    expect(
        host
            .querySelector(".quarry-explore-manage")
            ?.getAttribute("aria-expanded"),
    ).toBe("false");
    explorer.dispose();
});
