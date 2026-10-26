import { afterEach, describe, expect, it } from "@jest/globals";
import { mountImageSearchFolders, openPreview, quarry } from "./settings";
import type {
    PreviewResponse,
    RunQueryResponse,
    SettingsResponse,
} from "./types";

const originalRequest = globalThis.genericRequest;
const pendingSaves: {
    receive: (result: SettingsResponse) => void;
    fail: () => void;
}[] = [];
afterEach(() => {
    while (pendingSaves.length) pendingSaves.shift()?.fail();
    globalThis.genericRequest = originalRequest;
});

const setup = (
    options: {
        deferSaves?: boolean;
        multipleDatasets?: boolean;
        deferSettingsReads?: boolean;
    } = {},
) => {
    const previews: ((result: PreviewResponse) => void)[] = [];
    const queries: ((result: RunQueryResponse) => void)[] = [];
    const queryRequests: Record<string, unknown>[] = [];
    const saves: Record<string, unknown>[] = [];
    const requests: Record<string, unknown>[] = [];
    const reads: (() => void)[] = [];
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
            queries.push(callback as (result: RunQueryResponse) => void);
            queryRequests.push(data);
        }
    };
    document.body.innerHTML = '<div id="quarry-tab-body"></div>';
    quarry.init();
    return {
        previews,
        saves,
        requests,
        queries,
        queryRequests,
        completeSave,
        failSave,
        completeRead: () => reads.shift()?.(),
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
