import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { mountImageSearchFolders, openPreview, quarry } from "./settings";
import type {
    PreviewResponse,
    RunQueryResponse,
    SettingsResponse,
} from "./types";

const originalRequest = globalThis.genericRequest;
const globals = globalThis as typeof globalThis & {
    uiImprover: typeof uiImprover;
};
const originalImprover = globals.uiImprover;
const originalChange = globalThis.triggerChangeFor;
const pendingSaves: {
    receive: (result: SettingsResponse) => void;
    fail: () => void;
}[] = [];
afterEach(() => {
    while (pendingSaves.length) pendingSaves.shift()?.fail();
    globalThis.genericRequest = originalRequest;
    globals.uiImprover = originalImprover;
    globalThis.triggerChangeFor = originalChange;
});

const setup = (
    options: {
        deferSaves?: boolean;
        namespaceDatasets?: boolean;
        emptyDatasets?: boolean;
        multipleDatasets?: boolean;
        deferSettingsReads?: boolean;
    } = {},
) => {
    const previews: ((result: PreviewResponse) => void)[] = [];
    const overviewQueries: ((result: RunQueryResponse) => void)[] = [];
    const queries: ((result: RunQueryResponse) => void)[] = [];
    const queryRequests: Record<string, unknown>[] = [];
    const saves: Record<string, unknown>[] = [];
    const requests: Record<string, unknown>[] = [];
    const reads: (() => void)[] = [];
    const refreshes: ((result: SettingsResponse) => void)[] = [];
    const toggles: {
        request: Record<string, unknown>;
        receive: (data: { success: boolean }) => void;
    }[] = [];
    let readCount = 0;
    const settings: SettingsResponse = {
        success: true,
        canViewImageHistory: true,
        datasetsFolder: "Data/Quarry",
        exploreUniqueLimit: 2000,
        exploreLengthLimit: 150,
        exploreDistinctPercent: 5,
        datasets: [
            {
                name: "test",
                enabled: true,
                columns: [
                    { name: "prompt", kind: "scalar" },
                    { name: "rating", kind: "scalar" },
                ],
                resolvedPromptColumn: "prompt",
                configuredPromptColumn: null,
                configuredTagColumns: [],
                rowCount: 20000,
                error: null,
            },
        ],
    };
    if (options.multipleDatasets && settings.datasets) {
        settings.datasets.push({ ...settings.datasets[0], name: "other" });
    }
    if (options.namespaceDatasets && settings.datasets) {
        settings.datasets.unshift({
            ...settings.datasets[0],
            name: "music/first",
        });
        settings.datasets.push({
            ...settings.datasets[0],
            name: "nl/preferred",
        });
    }
    if (options.emptyDatasets) settings.datasets = [];
    let completedSaves = 0;
    const completeSave = () => {
        const request = saves[completedSaves++];
        const promptColumns = JSON.parse(String(request.promptColumnsJson));
        const tagColumns = JSON.parse(String(request.tagColumnsJson));
        const disabledDatasets = JSON.parse(
            String(request.disabledDatasetsJson),
        ) as string[];
        pendingSaves.shift()?.receive({
            ...settings,
            success: true,
            datasets: settings.datasets?.map((dataset) => ({
                ...dataset,
                enabled: !disabledDatasets.includes(dataset.name),
                configuredPromptColumn: promptColumns[dataset.name] ?? null,
                resolvedPromptColumn: promptColumns[dataset.name] ?? "prompt",
                configuredTagColumns: tagColumns[dataset.name] ?? [],
            })),
        });
    };
    const failSave = () => {
        completedSaves++;
        pendingSaves.shift()?.fail();
    };
    globalThis.genericRequest = <T>(
        name: string,
        data: Record<string, unknown>,
        callback: (data: T) => void,
        _depth?: number,
        errorHandle?: ((error: unknown) => void) | null,
    ): void => {
        if (name === "QuarryListAvailableDatasets")
            callback({
                success: true,
                datasets: [
                    {
                        name: "nl/remote",
                        repoPath: "nl/remote.lance",
                        installed: false,
                        sizeBytes: 100,
                    },
                ],
                tokenSet: true,
            } as T);
        if (name === "QuarryDownloadStatus")
            callback({ success: true, active: false } as T);
        if (name === "QuarryRefresh")
            refreshes.push(callback as (result: SettingsResponse) => void);
        if (name === "QuarryGetSettings") {
            const response = JSON.parse(JSON.stringify(settings)) as T;
            if (options.deferSettingsReads && readCount++ > 0)
                reads.push(() => callback(response));
            else callback(response);
        }
        if (name === "QuarrySetDatasetEnabled") {
            toggles.push({
                request: data,
                receive: callback as (data: { success: boolean }) => void,
            });
        }
        if (name === "QuarryPreviewDataset") {
            previews.push(callback as (result: PreviewResponse) => void);
            requests.push(data);
        }
        if (name === "QuarrySaveSettings") {
            saves.push(data);
            pendingSaves.push({
                receive: callback as (result: SettingsResponse) => void,
                fail: () => errorHandle?.("Save request failed"),
            });
            if (!options.deferSaves) completeSave();
        }
        if (name === "QuarryRunQuery") {
            if (data.maxResults === 10) {
                overviewQueries.push(
                    callback as (result: RunQueryResponse) => void,
                );
                return;
            }
            queries.push(callback as (result: RunQueryResponse) => void);
            queryRequests.push(data);
        }
    };
    document.body.innerHTML = '<div id="quarry-tab-body"></div>';
    quarry.init();
    return {
        previews,
        overviewQueries,
        saves,
        requests,
        queries,
        queryRequests,
        completeSave,
        failSave,
        completeRead: () => reads.shift()?.(),
        completeRefresh: (datasets: SettingsResponse["datasets"]) =>
            refreshes.shift()?.({ ...settings, datasets }),
        toggles,
    };
};

const openWithRows = () => {
    openPreview("test");
    document.querySelector<HTMLButtonElement>('[data-view="rows"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-view="fields"]')?.click();
};

describe("Explore integration", () => {
    it("ignores an older request even when reopening the same dataset", () => {
        const { previews } = setup();
        openWithRows();
        openWithRows();
        previews[1]({
            success: true,
            columns: ["prompt", "rating"],
            rows: [
                ["new", "g"],
                ["new", "s"],
            ],
            rowCount: 20000,
        });
        previews[0]({
            success: true,
            columns: ["prompt"],
            rows: [["stale"]],
            rowCount: 1,
        });
        const body = document.getElementById("quarry-preview-body");
        expect(body?.textContent).toContain("new");
        expect(body?.textContent).not.toContain("stale");
        expect(
            document.getElementById("quarry-preview-status")?.textContent,
        ).toContain("20,000");
    });
    it("leaves loading controls usable after an API error", () => {
        const { previews } = setup();
        openWithRows();
        previews[0]({ success: false, error: "Sample unavailable" });
        expect(
            document.getElementById("quarry-preview-status")?.textContent,
        ).toBe("Sample unavailable");
        const more = document.getElementById(
            "quarry-preview-refresh",
        ) as HTMLButtonElement;
        expect(more.disabled).toBe(false);
        more.click();
        expect(previews).toHaveLength(2);
    });
    it("caps displayed rows at 100 and still allows refreshing", () => {
        const { previews } = setup();
        openWithRows();
        previews[0]({
            success: true,
            columns: ["prompt"],
            rows: Array.from({ length: 10000 }, () => ["sample"]),
            rowCount: 20000,
        });
        expect(
            (
                document.getElementById(
                    "quarry-preview-refresh",
                ) as HTMLButtonElement
            ).disabled,
        ).toBe(false);
        expect(
            document.querySelectorAll(".quarry-explore-rows tbody tr"),
        ).toHaveLength(100);
        expect(
            document.getElementById("quarry-preview-status")?.textContent,
        ).toContain("100");
    });
    it("saves output and tag choices from dataset settings inside Explore", () => {
        const { saves } = setup();
        openPreview("test");
        const output = document.querySelector<HTMLSelectElement>(
            ".quarry-dataset-column",
        ) as HTMLSelectElement;
        output.value = "rating";
        const checkbox = document.querySelector<HTMLInputElement>(
            '.quarry-dataset-tag[value="rating"]',
        ) as HTMLInputElement;
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
        document
            .querySelector<HTMLButtonElement>("[data-save-dataset-settings]")
            ?.click();
        expect(saves[0].promptColumnsJson).toBe('{"test":"rating"}');
        expect(saves[0].tagColumnsJson).toBe('{"test":["rating"]}');
    });
    it("preserves saves across dataset navigation and serializes overlapping writes", () => {
        const { saves, completeSave } = setup({
            deferSaves: true,
            multipleDatasets: true,
        });
        openPreview("test");
        document
            .querySelector<HTMLButtonElement>('[data-dataset-mode="combine"]')
            ?.click();
        document
            .querySelector<HTMLInputElement>('[data-include-dataset="other"]')
            ?.click();
        document
            .querySelector<HTMLButtonElement>('[data-view="settings"]')
            ?.click();
        const output = () =>
            document.querySelector<HTMLSelectElement>(
                ".quarry-dataset-column",
            ) as HTMLSelectElement;
        const save = () =>
            document
                .querySelector<HTMLButtonElement>(
                    "[data-save-dataset-settings]",
                )
                ?.click();
        const changeSource = (name: string) => {
            const select = document.querySelector<HTMLSelectElement>(
                ".quarry-explore-settings-source select",
            ) as HTMLSelectElement;
            select.value = name;
            select.dispatchEvent(new Event("change"));
        };
        output().value = "rating";
        (
            document.querySelector(
                '.quarry-dataset-tag[value="rating"]',
            ) as HTMLInputElement
        ).checked = true;
        save();
        completeSave();
        output().value = "prompt";
        save();
        changeSource("other");
        output().value = "rating";
        save();
        expect(saves).toHaveLength(2);
        completeSave();
        expect(saves).toHaveLength(3);
        expect(JSON.parse(String(saves[2].promptColumnsJson))).toEqual({
            test: "prompt",
            other: "rating",
        });
        expect(JSON.parse(String(saves[2].tagColumnsJson))).toEqual({
            test: ["rating"],
            other: [],
        });
        completeSave();
        changeSource("test");
        expect(output().value).toBe("prompt");
        expect(
            (
                document.querySelector(
                    '.quarry-dataset-tag[value="rating"]',
                ) as HTMLInputElement
            ).checked,
        ).toBe(true);
    });
    it("locks dataset settings while saving and unlocks them after success or failure", () => {
        const { completeSave, failSave } = setup({ deferSaves: true });
        openPreview("test");
        const controls = Array.from(
            document.querySelectorAll<
                HTMLInputElement | HTMLSelectElement | HTMLButtonElement
            >(
                ".quarry-explore-settings-content input, .quarry-explore-settings-content select, .quarry-explore-settings-content button",
            ),
        );
        const save = document.querySelector<HTMLButtonElement>(
            "[data-save-dataset-settings]",
        );
        if (!save) throw new Error("Missing dataset settings save button");
        save.click();
        expect(controls.every((control) => control.disabled)).toBe(true);
        completeSave();
        expect(controls.every((control) => !control.disabled)).toBe(true);
        save.click();
        expect(controls.every((control) => control.disabled)).toBe(true);
        failSave();
        expect(controls.every((control) => !control.disabled)).toBe(true);
    });
    it("continues queued saves after a request error and restores the failed save button", () => {
        const { saves, completeSave, failSave } = setup({ deferSaves: true });
        openPreview("test");
        (
            document.querySelector(
                ".quarry-dataset-column",
            ) as HTMLSelectElement
        ).value = "rating";
        document
            .querySelector<HTMLButtonElement>("[data-save-dataset-settings]")
            ?.click();
        document
            .getElementById("quarry-form")
            ?.dispatchEvent(new Event("submit", { cancelable: true }));
        const button = document.querySelector<HTMLButtonElement>(
            "[data-save-dataset-settings]",
        );
        expect(saves).toHaveLength(1);
        expect(button?.disabled).toBe(true);
        failSave();
        expect(button?.disabled).toBe(false);
        expect(saves).toHaveLength(2);
        expect(JSON.parse(String(saves[1].promptColumnsJson))).toEqual({});
        completeSave();
    });
    it("keeps an earlier settings read from reverting a later dataset save", () => {
        const { saves, completeSave, completeRead } = setup({
            deferSaves: true,
            deferSettingsReads: true,
        });
        mountImageSearchFolders(document.createElement("div"));
        openPreview("test");
        (
            document.querySelector(
                ".quarry-dataset-column",
            ) as HTMLSelectElement
        ).value = "rating";
        document
            .querySelector<HTMLButtonElement>("[data-save-dataset-settings]")
            ?.click();
        expect(saves).toHaveLength(0);
        completeRead();
        expect(saves).toHaveLength(1);
        completeSave();
        document
            .getElementById("quarry-form")
            ?.dispatchEvent(new Event("submit", { cancelable: true }));
        expect(JSON.parse(String(saves[1].promptColumnsJson))).toEqual({
            test: "rating",
        });
        completeSave();
    });
    it("preserves a queued wildcard toggle after a full save replaces the catalog", () => {
        const { saves, completeSave, toggles } = setup({ deferSaves: true });
        openPreview("test");
        document
            .querySelector<HTMLButtonElement>("[data-save-dataset-settings]")
            ?.click();
        const toggle = () =>
            document.querySelector<HTMLButtonElement>(
                '.quarry-dataset-enable[data-dataset="test"]',
            ) as HTMLButtonElement;
        toggle().click();
        expect(toggles).toHaveLength(0);
        completeSave();
        expect(toggles).toHaveLength(1);
        expect(toggles[0].request).toEqual({ dataset: "test", enabled: false });
        toggles[0].receive({ success: true });
        expect(toggle().getAttribute("aria-checked")).toBe("false");
        expect(toggle().disabled).toBe(false);
        document
            .getElementById("quarry-form")
            ?.dispatchEvent(new Event("submit", { cancelable: true }));
        expect(JSON.parse(String(saves[1].disabledDatasetsJson))).toEqual([
            "test",
        ]);
        completeSave();
    });
    it("loads and saves all recurring-value limits", () => {
        const { saves } = setup();
        const inputs = [
            "quarry-explore-unique-limit",
            "quarry-explore-length-limit",
            "quarry-explore-distinct-percent",
        ].map((id) => document.getElementById(id) as HTMLInputElement);
        expect(inputs.map((input) => input.value)).toEqual([
            "2000",
            "150",
            "5",
        ]);
        ["3000", "200", "15"].forEach((value, index) => {
            inputs[index].value = value;
        });
        document
            .getElementById("quarry-form")
            ?.dispatchEvent(
                new Event("submit", { bubbles: true, cancelable: true }),
            );
        expect(saves[0]).toMatchObject({
            exploreUniqueLimit: 3000,
            exploreLengthLimit: 200,
            exploreDistinctPercent: 15,
        });
    });
    it("replaces each 100-row sample without losing filters", () => {
        const { previews, requests } = setup();
        openWithRows();
        previews[0]({
            success: true,
            columns: ["prompt"],
            rows: Array.from({ length: 100 }, (_, i) => [`first ${i}`]),
            rowCount: 20000,
        });
        const input = document.querySelector<HTMLInputElement>(
            ".quarry-explore-value",
        ) as HTMLInputElement;
        input.value = "keep filter";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        expect(
            document.querySelector<HTMLElement>(".quarry-explore-rows")?.hidden,
        ).toBe(true);
        document
            .querySelector<HTMLButtonElement>('[data-view="rows"]')
            ?.click();
        expect(
            document.querySelector<HTMLElement>(".quarry-explore-rows")?.hidden,
        ).toBe(false);
        expect(
            document.querySelector<HTMLElement>(".quarry-explore-fields-view")
                ?.hidden,
        ).toBe(true);
        expect(
            document
                .querySelector('[data-view="rows"]')
                ?.getAttribute("aria-pressed"),
        ).toBe("true");
        expect(
            document
                .querySelector('[data-view="fields"]')
                ?.getAttribute("aria-pressed"),
        ).toBe("false");
        expect(requests[1].limit).toBe(100);
        previews[1]({
            success: true,
            columns: ["prompt"],
            rows: Array.from({ length: 100 }, (_, i) => [`second ${i}`]),
            rowCount: 20000,
        });
        expect(
            document.querySelectorAll(".quarry-explore-rows tbody tr"),
        ).toHaveLength(100);
        expect(
            document.querySelector(".quarry-explore-rows")?.textContent,
        ).not.toContain("first");
        document
            .querySelector<HTMLButtonElement>('[data-view="rows"]')
            ?.click();
        expect(requests[2].limit).toBe(100);
        previews[2]({
            success: true,
            columns: ["prompt"],
            rows: [["fresh"]],
            rowCount: 20000,
        });
        expect(
            document.querySelectorAll(".quarry-explore-rows tbody tr"),
        ).toHaveLength(1);
        expect(
            document.querySelector(".quarry-explore-rows")?.textContent,
        ).not.toContain("first");
        expect(
            document.querySelector(".quarry-explore-query")?.textContent,
        ).toContain("prompt=keep filter");
        document.getElementById("quarry-preview-refresh")?.click();
        expect(requests).toHaveLength(4);
    });
    it("ignores an old refresh response after requesting a new sample", () => {
        const { previews } = setup();
        openWithRows();
        previews[0]({
            success: true,
            columns: ["prompt"],
            rows: Array.from({ length: 100 }, () => ["first"]),
            rowCount: 20000,
        });
        document
            .querySelector<HTMLButtonElement>('[data-view="rows"]')
            ?.click();
        document
            .querySelector<HTMLButtonElement>('[data-view="rows"]')
            ?.click();
        previews[2]({
            success: true,
            columns: ["prompt"],
            rows: [["new sample"]],
            rowCount: 20000,
        });
        previews[1]({
            success: true,
            columns: ["prompt"],
            rows: [["stale refresh"]],
            rowCount: 20000,
        });
        expect(
            document.querySelector(".quarry-explore-rows")?.textContent,
        ).not.toContain("stale refresh");
    });
    it("keeps Fields selected if the user switches back during a refresh", () => {
        const { previews } = setup();
        openWithRows();
        previews[0]({
            success: true,
            columns: ["prompt"],
            rows: [["initial"]],
        });
        document
            .querySelector<HTMLButtonElement>('[data-view="rows"]')
            ?.click();
        expect(
            document.querySelector<HTMLElement>(".quarry-explore-rows")?.hidden,
        ).toBe(false);
        document
            .querySelector<HTMLButtonElement>('[data-view="fields"]')
            ?.click();
        previews[1]({
            success: true,
            columns: ["prompt"],
            rows: [["refreshed"]],
        });
        expect(
            document.querySelector<HTMLElement>(".quarry-explore-rows")?.hidden,
        ).toBe(true);
        expect(
            document.querySelector<HTMLElement>(".quarry-explore-fields-view")
                ?.hidden,
        ).toBe(false);
        expect(
            document.querySelector(".quarry-explore-rows")?.textContent,
        ).toContain("refreshed");
    });
    it("shows Refresh sample only on Sample rows, including after reopening", () => {
        const { previews, requests } = setup();
        openWithRows();
        previews[0]({
            success: true,
            columns: ["prompt"],
            rows: [["initial"]],
        });
        const refresh = document.getElementById(
            "quarry-preview-refresh",
        ) as HTMLButtonElement;
        expect(refresh.hidden).toBe(true);
        document
            .querySelector<HTMLButtonElement>('[data-view="rows"]')
            ?.click();
        expect(refresh.hidden).toBe(false);
        previews[1]({ success: true, columns: ["prompt"], rows: [["sample"]] });
        refresh.click();
        expect(requests).toHaveLength(3);
        expect(
            document.querySelector<HTMLElement>(".quarry-explore-rows")?.hidden,
        ).toBe(false);
        document
            .querySelector<HTMLButtonElement>('[data-view="fields"]')
            ?.click();
        expect(refresh.hidden).toBe(true);
        previews[2]({
            success: true,
            columns: ["prompt"],
            rows: [["refreshed"]],
        });
        expect(refresh.hidden).toBe(true);
        expect(
            document.querySelector<HTMLElement>(".quarry-explore-fields-view")
                ?.hidden,
        ).toBe(false);
        document
            .querySelector<HTMLButtonElement>('[data-view="rows"]')
            ?.click();
        expect(refresh.hidden).toBe(false);
        openWithRows();
        expect(refresh.hidden).toBe(true);
    });
    it("opens Fields with 100 default query outputs and no refresh button", () => {
        const { queries, queryRequests } = setup();
        openPreview("test");
        expect(queryRequests).toEqual([{ query: "<q:test>", maxResults: 100 }]);
        queries[0]({
            total: 20000,
            results: Array.from({ length: 100 }, (_, i) => ({
                dataset: "test",
                prompt: `output ${i}`,
            })),
        });
        const fields = document.querySelector<HTMLElement>(
            ".quarry-explore-fields-view",
        );
        expect(fields?.hidden).toBe(false);
        expect(
            fields?.querySelectorAll(".quarry-explore-results tbody tr"),
        ).toHaveLength(100);
        expect(
            (document.getElementById("quarry-preview-refresh") as HTMLElement)
                .hidden,
        ).toBe(true);
        document
            .querySelector<HTMLButtonElement>('[data-action="test"]')
            ?.click();
        expect(queryRequests[1]).toEqual({
            query: "<q:test>",
            maxResults: 100,
        });
    });
    it("discards initial default results if the filter changes before they arrive", () => {
        const { queries } = setup();
        openPreview("test");
        const input = document.querySelector<HTMLInputElement>(
            ".quarry-explore-value",
        ) as HTMLInputElement;
        input.value = "new filter";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        queries[0]({
            total: 1,
            results: [{ dataset: "test", prompt: "stale default output" }],
        });
        expect(
            document.querySelector(".quarry-explore-results")?.textContent,
        ).not.toContain("stale default output");
    });
});

describe("Explore scroll regions", () => {
    it("synchronizes raw headers with horizontal scrolling", () => {
        const { previews } = setup();
        openWithRows();
        previews[0]({
            success: true,
            columns: ["prompt", "rating"],
            rows: [["example", "g"]],
            rowCount: 1,
        });
        const header = document.querySelector<HTMLElement>(
            ".quarry-explore-table-header",
        );
        const scroll = document.querySelector<HTMLElement>(
            ".quarry-explore-table-scroll",
        );
        if (!scroll) throw new Error("Missing dataset scroller");
        scroll.scrollLeft = 120;
        scroll.dispatchEvent(new Event("scroll"));
        expect(header?.scrollLeft).toBe(120);
    });
});

it("loads raw dataset rows only when their tab is opened", () => {
    const { previews, queries } = setup();
    openPreview("test");
    expect(queries).toHaveLength(1);
    expect(previews).toHaveLength(0);
    document.querySelector<HTMLButtonElement>('[data-view="rows"]')?.click();
    expect(previews).toHaveLength(1);
});

it("sizes dataset columns from displayed contents while keeping header widths aligned", () => {
    const { previews } = setup();
    openWithRows();
    previews[0]({
        success: true,
        columns: ["prompt", "rating"],
        rows: [["A long paragraph ".repeat(30), "g"]],
        rowCount: 20000,
    });
    const body = document.querySelectorAll<HTMLTableColElement>(
        ".quarry-explore-table-scroll col",
    );
    const header = document.querySelectorAll<HTMLTableColElement>(
        ".quarry-explore-table-header col",
    );
    expect(parseFloat(body[0].style.width)).toBeGreaterThan(
        parseFloat(body[1].style.width) * 3,
    );
    expect(header[0].style.width).toBe(body[0].style.width);
    expect(header[1].style.width).toBe(body[1].style.width);
});

describe("Shared library workspace", () => {
    it("moves the same component into Explore and back, preserving drafts and scroll", () => {
        const { overviewQueries, queries } = setup();
        expect(overviewQueries).toHaveLength(1);
        const host = document.getElementById("quarry-library");
        const filter = host?.querySelector<HTMLInputElement>(
            ".quarry-explore-value",
        );
        const rail = host?.querySelector<HTMLElement>(
            ".quarry-explore-rail-list",
        );
        openPreview("test");
        expect(
            document.getElementById("quarry-preview-body")?.contains(host),
        ).toBe(true);
        if (!filter || !rail) throw new Error("Missing editor");
        filter.value = "retained";
        filter.dispatchEvent(new Event("input", { bubbles: true }));
        rail.scrollTop = 80;
        document
            .getElementById("quarry-preview-modal")
            ?.dispatchEvent(new Event("hidden.bs.modal"));
        expect(
            document.getElementById("quarry-library-home")?.contains(host),
        ).toBe(true);
        expect(filter.value).toBe("retained");
        expect(rail.scrollTop).toBe(80);
        expect(document.querySelectorAll(".quarry-explore")).toHaveLength(1);
        openPreview("test");
        expect(host?.querySelector(".quarry-explore-value")).toBe(filter);
        expect(queries.length).toBeGreaterThan(0);
    });
    it("restores Full records after choosing another dataset in Library", () => {
        const { requests } = setup({ multipleDatasets: true });
        openPreview("test");
        document
            .querySelector<HTMLButtonElement>('[data-view="rows"]')
            ?.click();
        document
            .getElementById("quarry-preview-modal")
            ?.dispatchEvent(new Event("hidden.bs.modal"));
        document
            .querySelector<HTMLButtonElement>('[data-browse-dataset="other"]')
            ?.click();
        document
            .querySelector<HTMLButtonElement>('[data-action="expand"]')
            ?.click();
        expect(requests.at(-1)?.dataset).toBe("other");
    });
    it("allows Library navigation after closing Combine with a single selection", () => {
        setup({ multipleDatasets: true });
        openPreview("test");
        document
            .querySelector<HTMLButtonElement>('[data-dataset-mode="combine"]')
            ?.click();
        document
            .getElementById("quarry-preview-modal")
            ?.dispatchEvent(new Event("hidden.bs.modal"));
        const previous = document.querySelector<HTMLButtonElement>(
            '[data-action="previous-dataset"]',
        );
        expect(previous?.disabled).toBe(false);
        previous?.click();
        expect(
            document.querySelector(".quarry-explore-scope")?.textContent,
        ).toContain("other");
    });
    it("updates sidebar counts after a full-record preview completes", () => {
        const { previews } = setup();
        openPreview("test");
        document
            .querySelector<HTMLButtonElement>('[data-view="rows"]')
            ?.click();
        previews[0]({
            success: true,
            rowCount: 42,
            columns: ["prompt"],
            rows: [["sample"]],
        });
        expect(
            document.querySelector('[data-browse-dataset="test"] small')
                ?.textContent,
        ).toBe("42 rows · rating");
    });
    it("edits the tag preview inline and finishes without changing the builder", () => {
        setup();
        openPreview("test");
        const editor = document.querySelector<HTMLFieldSetElement>(
            ".quarry-explore-editor",
        );
        document
            .querySelector<HTMLButtonElement>('[data-action="edit-tag"]')
            ?.click();
        expect(editor?.hidden).toBe(false);
        expect(editor?.disabled).toBe(true);
        const input = document.querySelector<HTMLTextAreaElement>(
            ".quarry-query-text-input",
        );
        if (!input) throw new Error("Missing tag editor");
        input.value = "<q[3]:test>";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document
            .querySelector<HTMLButtonElement>('[data-action="done-tag"]')
            ?.click();
        expect(
            document.querySelector<HTMLElement>(".quarry-query-text")?.hidden,
        ).toBe(true);
        expect(
            document.querySelector<HTMLElement>(".quarry-explore-query")
                ?.hidden,
        ).toBe(false);
        expect(
            document.querySelector(".quarry-explore-query")?.textContent,
        ).toBe("<q[3]:test>");
        expect(document.getElementById("quarry-query-text")).toBeNull();
    });
});

it("reloads visible overview after a deferred default-output save and ignores the old sample", () => {
    const { overviewQueries, completeSave } = setup({ deferSaves: true });
    openPreview("test");
    document
        .querySelector<HTMLButtonElement>('[data-view="settings"]')
        ?.click();
    const select = document.querySelector<HTMLSelectElement>(
        ".quarry-explore-settings-content select",
    );
    if (!select) throw new Error("Missing settings select");
    select.value = "rating";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    document
        .querySelector<HTMLButtonElement>("[data-save-dataset-settings]")
        ?.click();
    document
        .getElementById("quarry-preview-modal")
        ?.dispatchEvent(new Event("hidden.bs.modal"));
    completeSave();
    expect(overviewQueries).toHaveLength(2);
    overviewQueries[1]({
        results: [{ dataset: "test", prompt: "fresh output" }],
        total: 1,
    });
    overviewQueries[0]({
        results: [{ dataset: "test", prompt: "stale output" }],
        total: 1,
    });
    expect(
        document.querySelector(".quarry-library-sample")?.textContent,
    ).toContain("fresh output");
    expect(
        document.querySelector(".quarry-library-sample")?.textContent,
    ).not.toContain("stale output");
    expect(
        document.getElementById("quarry-library")?.closest("form"),
    ).toBeNull();
});

describe("Workspace corrections", () => {
    it("restores the library host when a pending refresh empties the open modal", () => {
        const { completeRefresh } = setup();
        document.getElementById("quarry-refresh")?.click();
        openPreview("test");
        document
            .querySelector<HTMLButtonElement>('[data-view="rows"]')
            ?.click();
        const library = document.getElementById("quarry-library");
        completeRefresh([]);
        for (const id of ["quarry-preview-refresh", "quarry-preview-status"])
            expect(document.getElementById(id)?.hidden).toBe(true);
        document
            .getElementById("quarry-preview-modal")
            ?.dispatchEvent(new Event("hidden.bs.modal"));
        expect(
            document.getElementById("quarry-library-home")?.contains(library),
        ).toBe(true);
        expect(library?.textContent).toContain("No datasets installed.");

        document.getElementById("quarry-refresh")?.click();
        completeRefresh([
            {
                name: "nl/replacement",
                columns: [{ name: "prompt", kind: "scalar" }],
                resolvedPromptColumn: "prompt",
                configuredPromptColumn: null,
                configuredTagColumns: [],
                rowCount: 10,
                error: null,
            },
        ]);
        expect(
            document.querySelector("#quarry-library-home .quarry-library-title")
                ?.textContent,
        ).toBe("nl/replacement");
    });
    it("keeps replacement datasets expanded and queries them inside the open modal", () => {
        const { completeRefresh, queryRequests } = setup();
        document.getElementById("quarry-refresh")?.click();
        openPreview("test");
        completeRefresh([
            {
                name: "nl/replacement",
                columns: [{ name: "prompt", kind: "scalar" }],
                resolvedPromptColumn: "prompt",
                configuredPromptColumn: null,
                configuredTagColumns: [],
                rowCount: 10,
                error: null,
            },
        ]);
        expect(
            document.querySelector<HTMLElement>(
                "#quarry-preview-body .quarry-library-overview",
            )?.hidden,
        ).toBe(true);
        expect(
            document.querySelector<HTMLElement>(
                "#quarry-preview-body .quarry-explore-fields-view",
            )?.hidden,
        ).toBe(false);
        expect(queryRequests.at(-1)?.query).toBe("<q:nl/replacement>");
    });
    it("starts in nl when other namespaces appear first", () => {
        setup({ namespaceDatasets: true });
        expect(
            document.querySelector(".quarry-explore-scope")?.textContent,
        ).toBe("nl/preferred");
        expect(
            document
                .querySelector('[data-namespace="nl/"]')
                ?.getAttribute("aria-expanded"),
        ).toBe("true");
        expect(
            document
                .querySelector('[data-namespace="music/"]')
                ?.getAttribute("aria-expanded"),
        ).toBe("false");
    });
    it("shares Explore with Downloads and preserves both drafts and selection", () => {
        setup();
        openPreview("test");
        const library = document.getElementById("quarry-library");
        document
            .querySelector<HTMLButtonElement>('[data-action="edit-tag"]')
            ?.click();
        const input = document.querySelector<HTMLTextAreaElement>(
            ".quarry-query-text-input",
        );
        if (!input) throw new Error("Missing tag editor");
        input.value = "<q[3]:test>";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document
            .querySelector<HTMLButtonElement>('[data-action="done-tag"]')
            ?.click();
        document
            .querySelector<HTMLButtonElement>('[data-modal-view="downloads"]')
            ?.click();
        const check = document.querySelector<HTMLInputElement>(
            ".quarry-remote-select",
        );
        check?.click();
        document
            .querySelector<HTMLButtonElement>('[data-modal-view="explore"]')
            ?.click();
        expect(
            document.querySelector(".quarry-explore-query")?.textContent,
        ).toBe("<q[3]:test>");
        expect(document.getElementById("quarry-library")).toBe(library);
        document
            .querySelector<HTMLButtonElement>('[data-modal-view="downloads"]')
            ?.click();
        expect(check?.checked).toBe(true);
        expect(document.getElementById("quarry-download-modal")).toBeNull();
        expect(document.querySelectorAll("#quarry-preview-modal")).toHaveLength(
            1,
        );
        document
            .getElementById("quarry-preview-modal")
            ?.dispatchEvent(new Event("hidden.bs.modal"));
        expect(
            document.getElementById("quarry-library-home")?.contains(library),
        ).toBe(true);
    });
    it("opens Downloads in the same modal with no installed datasets", () => {
        setup({ emptyDatasets: true });
        document.getElementById("quarry-download-datasets")?.click();
        expect(
            document.querySelector<HTMLElement>("#quarry-download-panel")
                ?.hidden,
        ).toBe(false);
        expect(
            document.querySelector<HTMLButtonElement>(
                '[data-modal-view="explore"]',
            )?.disabled,
        ).toBe(true);
        expect(document.querySelector(".quarry-remote-select")).not.toBeNull();
        expect(document.getElementById("quarry-download-modal")).toBeNull();
    });
});

describe("Compact library actions", () => {
    it("makes settings exclusive and restores the previous table or library view", () => {
        setup();
        const home = document.getElementById(
            "quarry-library-home",
        ) as HTMLElement;
        const table = document.getElementById("quarry-datasets") as HTMLElement;
        const settings = document.getElementById(
            "quarry-global-settings",
        ) as HTMLElement;
        const toggle = document.getElementById(
            "quarry-settings-toggle",
        ) as HTMLElement;
        const host = document.getElementById("quarry-library");
        toggle.click();
        expect([home.hidden, table.hidden, settings.hidden]).toEqual([
            true,
            true,
            false,
        ]);
        toggle.click();
        expect([home.hidden, table.hidden, settings.hidden]).toEqual([
            false,
            true,
            true,
        ]);
        document
            .querySelector<HTMLButtonElement>('[data-library-view="table"]')
            ?.click();
        toggle.click();
        toggle.click();
        expect([home.hidden, table.hidden, settings.hidden]).toEqual([
            true,
            false,
            true,
        ]);
        toggle.click();
        document
            .querySelector<HTMLButtonElement>('[data-library-view="library"]')
            ?.click();
        expect([home.hidden, table.hidden, settings.hidden]).toEqual([
            false,
            true,
            true,
        ]);
        expect(document.getElementById("quarry-library")).toBe(host);
    });
    it("inserts a basic dataset tag from Library and Table without using the hidden Explore draft", () => {
        setup();
        const prompt = document.createElement("textarea");
        prompt.id = "alt_prompt_textbox";
        document.body.append(prompt);
        globals.uiImprover = {
            getLastSelectedTextbox: () => [prompt, prompt.value.length],
        };
        globalThis.triggerChangeFor = jest.fn();
        openPreview("test");
        const filter = document.querySelector<HTMLInputElement>(
            ".quarry-explore-value",
        ) as HTMLInputElement;
        filter.value = "hidden filter";
        filter.dispatchEvent(new Event("input", { bubbles: true }));
        document
            .getElementById("quarry-preview-modal")
            ?.dispatchEvent(new Event("hidden.bs.modal"));
        document
            .querySelector<HTMLButtonElement>('[data-action="use-overview"]')
            ?.click();
        expect(prompt.value).toBe("<q:test>");
        expect(filter.value).toBe("hidden filter");
        prompt.value = "";
        document
            .querySelector<HTMLButtonElement>('[data-library-view="table"]')
            ?.click();
        document
            .querySelector<HTMLButtonElement>(
                '.quarry-dataset-use[data-dataset="test"]',
            )
            ?.click();
        expect(prompt.value).toBe("<q:test>");
    });
    it("describes all combined datasets and inserts the same sources shown by the sample", () => {
        const { overviewQueries } = setup({ multipleDatasets: true });
        openPreview("test");
        document
            .querySelector<HTMLButtonElement>('[data-dataset-mode="combine"]')
            ?.click();
        document
            .querySelector<HTMLInputElement>('[data-include-dataset="other"]')
            ?.click();
        document
            .getElementById("quarry-preview-modal")
            ?.dispatchEvent(new Event("hidden.bs.modal"));
        expect(
            document.querySelector(".quarry-library-title")?.textContent,
        ).toBe("test, other");
        expect(
            document.querySelector(".quarry-library-metadata")?.textContent,
        ).toContain("40,000 rows");
        expect(
            document.querySelector(".quarry-library-metadata")?.textContent,
        ).toContain("Shared columns: prompt, rating");
        expect(document.querySelector(".quarry-library-wildcard")).toBeNull();
        const prompt = document.createElement("textarea");
        prompt.id = "alt_prompt_textbox";
        document.body.append(prompt);
        globals.uiImprover = {
            getLastSelectedTextbox: () => [prompt, prompt.value.length],
        };
        globalThis.triggerChangeFor = jest.fn();
        document
            .querySelector<HTMLButtonElement>('[data-action="use-overview"]')
            ?.click();
        expect(prompt.value).toBe("<q:test,other>");
        overviewQueries.at(-1)?.({
            results: [
                { dataset: "test", prompt: "First" },
                { dataset: "other", prompt: "Second" },
            ],
        });
        expect(
            document.querySelectorAll(
                ".quarry-library-sample .quarry-runquery-dataset-heading",
            ),
        ).toHaveLength(2);
    });
});

it("restores name-click prompt merging and toggling in Library and Table", () => {
    setup();
    const prompt = document.createElement("textarea");
    prompt.id = "alt_prompt_textbox";
    prompt.value = "before <q:other[rating=g]:prompt> after";
    document.body.append(prompt);
    globals.uiImprover = { getLastSelectedTextbox: () => [prompt, 0] };
    globalThis.triggerChangeFor = jest.fn();
    document
        .querySelector<HTMLButtonElement>('[data-prompt-dataset="test"]')
        ?.click();
    expect(prompt.value).toBe("before <q:other,test[rating=g]:prompt> after");
    document
        .querySelector<HTMLButtonElement>('[data-library-view="table"]')
        ?.click();
    document
        .querySelector<HTMLButtonElement>(
            '.quarry-dataset-name-link[data-dataset="test"]',
        )
        ?.click();
    expect(prompt.value).toBe("before <q:other[rating=g]:prompt> after");
    expect(document.getElementById("quarry-datasets")?.hidden).toBe(false);
    document
        .querySelector<HTMLButtonElement>(
            '.quarry-dataset-name-link[data-dataset="test"]',
        )
        ?.click();
    expect(prompt.value).toBe("before <q:other,test[rating=g]:prompt> after");
});

it("refreshes ten samples and discards older refresh responses without changing the dataset", () => {
    const { overviewQueries } = setup();
    const refresh = document.querySelector<HTMLButtonElement>(
        '[data-action="refresh-overview"]',
    );
    refresh?.click();
    expect(overviewQueries).toHaveLength(2);
    overviewQueries[1]({
        results: [{ dataset: "test", prompt: "New sample" }],
    });
    overviewQueries[0]({
        results: [{ dataset: "test", prompt: "Old sample" }],
    });
    expect(
        document.querySelector(".quarry-library-sample")?.textContent,
    ).toContain("New sample");
    expect(
        document.querySelector(".quarry-library-sample")?.textContent,
    ).not.toContain("Old sample");
    expect(document.querySelector(".quarry-library-title")?.textContent).toBe(
        "test",
    );
});

it("keeps the current dataset highlighted when opening Explore with a retained manual query", () => {
    setup();
    openPreview("test");
    const current = () =>
        document
            .querySelector('[data-browse-dataset="test"]')
            ?.getAttribute("aria-current");
    expect(current()).toBe("true");
    document
        .querySelector<HTMLButtonElement>('[data-action="edit-tag"]')
        ?.click();
    document
        .querySelector<HTMLButtonElement>('[data-action="done-tag"]')
        ?.click();
    document
        .getElementById("quarry-preview-modal")
        ?.dispatchEvent(new Event("hidden.bs.modal"));
    openPreview("test");
    expect(current()).toBe("true");
    for (const view of ["rows", "settings", "fields"]) {
        document
            .querySelector<HTMLButtonElement>(`[data-view="${view}"]`)
            ?.click();
        expect(current()).toBe("true");
    }
});

it("keeps one working toolbar across Library, Table, Settings and Explore", () => {
    setup();
    const toolbar = document.querySelector(".quarry-catalog-toolbar");
    const overview = document.querySelector(".quarry-library-overview");
    const workspace = document.querySelector(".quarry-workspace-content");
    const actions = document.querySelector(".quarry-library-actions");
    const selectView = (view: string) =>
        document
            .querySelector<HTMLButtonElement>(`[data-library-view="${view}"]`)
            ?.click();
    expect(toolbar?.parentElement).toBe(overview);
    expect(actions?.parentElement).toBe(toolbar);
    const tableButton = document.querySelector<HTMLButtonElement>(
        '[data-library-view="table"]',
    );
    tableButton?.focus();
    selectView("table");
    expect(document.activeElement).toBe(tableButton);
    expect(toolbar?.parentElement).toBe(workspace);
    expect(actions?.parentElement).toBe(overview);
    document.getElementById("quarry-settings-toggle")?.click();
    expect(toolbar?.parentElement).toBe(workspace);
    const libraryButton = document.querySelector<HTMLButtonElement>(
        '[data-library-view="library"]',
    );
    libraryButton?.focus();
    selectView("library");
    expect(document.activeElement).toBe(libraryButton);
    expect(toolbar?.parentElement).toBe(overview);
    document
        .querySelector<HTMLButtonElement>('[data-action="expand"]')
        ?.click();
    expect(toolbar?.parentElement).toBe(workspace);
    expect(
        document.getElementById("quarry-preview-modal")?.contains(toolbar),
    ).toBe(false);
    document
        .getElementById("quarry-preview-modal")
        ?.dispatchEvent(new Event("hidden.bs.modal"));
    expect(toolbar?.parentElement).toBe(overview);
    expect(actions?.parentElement).toBe(toolbar);
    expect(document.querySelectorAll(".quarry-catalog-toolbar")).toHaveLength(
        1,
    );
});

it("loads results on opening Explore and on reopening a changed manual draft", () => {
    const { queries, queryRequests } = setup({ multipleDatasets: true });
    openPreview("test");
    expect(queryRequests.at(-1)?.query).toBe("<q:test>");
    queries.at(-1)?.({
        results: [{ dataset: "test", prompt: "Initial result" }],
        total: 1,
    });
    expect(
        document.querySelector(".quarry-explore-results")?.textContent,
    ).toContain("Initial result");
    document
        .querySelector<HTMLButtonElement>('[data-action="edit-tag"]')
        ?.click();
    const input = document.querySelector<HTMLTextAreaElement>(
        ".quarry-query-text-input",
    ) as HTMLTextAreaElement;
    input.value = "<q[3]:test[rating=g]>";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document
        .querySelector<HTMLButtonElement>('[data-action="done-tag"]')
        ?.click();
    document
        .getElementById("quarry-preview-modal")
        ?.dispatchEvent(new Event("hidden.bs.modal"));
    openPreview("test");
    expect(queryRequests.at(-1)?.query).toBe(input.value);
    const stale = queries.at(-1);
    document
        .querySelector<HTMLButtonElement>('[data-browse-dataset="other"]')
        ?.click();
    expect(queryRequests.at(-1)?.query).toBe("<q:other>");
    queries.at(-1)?.({
        results: [{ dataset: "other", prompt: "Other result" }],
        total: 1,
    });
    stale?.({
        results: [{ dataset: "test", prompt: "Stale result" }],
        total: 1,
    });
    expect(
        document.querySelector(".quarry-explore-results")?.textContent,
    ).toContain("Other result");
    expect(
        document.querySelector(".quarry-explore-results")?.textContent,
    ).not.toContain("Stale result");
    document
        .querySelector<HTMLButtonElement>('[data-browse-dataset="test"]')
        ?.click();
    expect(queryRequests.at(-1)?.query).toBe("<q[3]:test[rating=g]>");
});
