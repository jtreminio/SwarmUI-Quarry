import { describe, expect, it } from "@jest/globals";
import {
    collectTagColumns,
    datasetColumnSettings,
    isDatasetEnabled,
    mountDatasetSettings,
    PREVIEW_ROW_LIMIT,
    quarry,
    renderDatasetSettings,
    renderEnableToggle,
    renderForm,
    renderPreviewStatus,
    renderPreviewTable,
} from "./settings";
import type { DatasetDto } from "./types";
import {
    allAncestorsExpanded,
    buildFolderTree,
    datasetFolder,
    datasetLeafName,
    escapeHtml,
    folderDatasetCount,
} from "./util";

/// Minimal valid dataset DTO for grouping/render tests; override just the fields a test cares about.
const makeDataset = (
    over: Partial<DatasetDto> & { name: string },
): DatasetDto => ({
    columns: [{ name: "prompt", kind: "scalar" }],
    resolvedPromptColumn: "prompt",
    configuredPromptColumn: null,
    configuredTagColumns: [],
    rowCount: 1,
    error: null,
    ...over,
});

describe("escapeHtml", () => {
    it("escapes angle brackets and ampersands", () => {
        expect(escapeHtml("<script>&")).toBe("&lt;script&gt;&amp;");
    });
});
it("preserves editable tag-search defaults in dataset settings", () => {
    const html = renderDatasetSettings({
        name: "prompts/1girl",
        columns: [
            { name: "prompt", kind: "scalar" },
            { name: "tags", kind: "list" },
            { name: "extra", kind: "scalar" },
        ],
        resolvedPromptColumn: "prompt",
        configuredPromptColumn: null,
        configuredTagColumns: ["tags", "extra"],
        rowCount: 1234,
        error: null,
    });
    expect(html).toContain(
        'input type="checkbox" class="quarry-dataset-tag" data-dataset="prompts/1girl" value="tags" checked',
    );
    expect(html).toContain('value="extra" checked');
    // The prompt column is not a configured tag column here, so its checkbox is unchecked.
    expect(html).toContain('value="prompt">');
    expect(html).not.toContain('value="prompt" checked');
});

describe("persistent dataset defaults", () => {
    it("opens general settings from the catalog toolbar without exposing image folder controls", () => {
        const originalRequest = globalThis.genericRequest;
        globalThis.genericRequest = <T>(
            name: string,
            _data: object,
            callback: (response: T) => void,
        ): void => {
            if (name === "QuarryGetSettings")
                callback({ success: true, datasets: [] } as T);
        };
        try {
            document.body.innerHTML = '<div id="quarry-tab-body"></div>';
            quarry.init();
            const panel = document.getElementById(
                "quarry-global-settings",
            ) as HTMLElement;
            const toggle = document.getElementById(
                "quarry-settings-toggle",
            ) as HTMLButtonElement;
            expect(panel.hidden).toBe(true);
            toggle.click();
            expect(panel.hidden).toBe(false);
            expect(toggle.getAttribute("aria-expanded")).toBe("true");
            expect(panel.querySelector('button[type="submit"]')).not.toBeNull();
            toggle.click();
            expect(panel.hidden).toBe(true);
            expect(renderForm("")).not.toContain("quarry-image-search-folders");
            expect(renderForm("")).not.toContain(
                '<details class="quarry-global-settings"',
            );
        } finally {
            globalThis.genericRequest = originalRequest;
            document.body.innerHTML = "";
        }
    });

    it("saves dataset defaults independently and preserves them during general settings saves", () => {
        const originalRequest = globalThis.genericRequest;
        const datasets = [
            makeDataset({
                name: "target",
                columns: [
                    { name: "prompt", kind: "scalar" },
                    { name: "full", kind: "scalar" },
                ],
            }),
            makeDataset({
                name: "other",
                configuredPromptColumn: "prompt",
                configuredTagColumns: ["prompt"],
                enabled: false,
            }),
        ];
        const saves: Record<string, unknown>[] = [];
        globalThis.genericRequest = <T>(
            name: string,
            data: object,
            callback: (response: T) => void,
        ): void => {
            if (name === "QuarryGetSettings")
                callback({
                    success: true,
                    datasetsFolder: "saved-folder",
                    addToExistingTag: false,
                    exploreUniqueLimit: 2000,
                    datasets,
                } as T);
            if (name === "QuarrySaveSettings") {
                saves.push(data as Record<string, unknown>);
                callback({
                    success: true,
                    datasetsFolder: "saved-folder",
                    addToExistingTag: false,
                    exploreUniqueLimit: 2000,
                    datasets,
                } as T);
            }
        };
        try {
            document.body.innerHTML = '<div id="quarry-tab-body"></div>';
            quarry.init();
            document
                .getElementById("quarry-form")
                ?.dispatchEvent(new Event("submit", { cancelable: true }));
            expect(JSON.parse(String(saves[0].promptColumnsJson))).toEqual({
                other: "prompt",
            });
            expect(JSON.parse(String(saves[0].tagColumnsJson))).toEqual({
                target: [],
                other: ["prompt"],
            });
            (
                document.getElementById("quarry-folder") as HTMLInputElement
            ).value = "unsaved-folder";
            const host = document.createElement("div");
            const cleanup = mountDatasetSettings(host, datasets[0], () => {});
            (host.querySelector("select") as HTMLSelectElement).value = "full";
            (
                host.querySelector('input[value="full"]') as HTMLInputElement
            ).checked = true;
            (
                host.querySelector(
                    "[data-save-dataset-settings]",
                ) as HTMLButtonElement
            ).click();
            expect(saves[1]).toMatchObject({
                datasetsFolder: "saved-folder",
                addToExistingTag: false,
                exploreUniqueLimit: 2000,
                disabledDatasetsJson: '["other"]',
            });
            expect(JSON.parse(String(saves[1].promptColumnsJson))).toEqual({
                target: "full",
                other: "prompt",
            });
            expect(JSON.parse(String(saves[1].tagColumnsJson))).toEqual({
                target: ["full"],
                other: ["prompt"],
            });
            cleanup();
        } finally {
            globalThis.genericRequest = originalRequest;
            document.body.innerHTML = "";
        }
    });

    it("preserves saved defaults when the catalog no longer contains editors", () => {
        const datasets = [
            makeDataset({ name: "automatic", resolvedPromptColumn: "prompt" }),
            makeDataset({
                name: "configured",
                configuredPromptColumn: "full",
                configuredTagColumns: ["artist", "rating"],
            }),
        ];
        expect(datasetColumnSettings(datasets)).toEqual({
            promptColumns: { configured: "full" },
            tagColumns: { automatic: [], configured: ["artist", "rating"] },
        });
        expect(
            renderDatasetSettings(makeDataset({ name: "automatic" })),
        ).toContain('value="" selected');
    });
});

describe("datasetFolder", () => {
    it("returns the directory portion of a foldered name", () => {
        expect(datasetFolder("anime/1girl")).toBe("anime");
        expect(datasetFolder("a/b/c")).toBe("a/b");
    });

    it("returns null for a top-level name", () => {
        expect(datasetFolder("loose")).toBeNull();
        expect(datasetFolder("Gustavosta.Stable-Diffusion-Prompts")).toBeNull();
    });
});

describe("datasetLeafName", () => {
    it("returns the part after the last slash", () => {
        expect(datasetLeafName("anime/1girl")).toBe("1girl");
        expect(datasetLeafName("a/b/c")).toBe("c");
    });

    it("returns the whole name when there is no slash", () => {
        expect(datasetLeafName("loose")).toBe("loose");
    });
});

describe("buildFolderTree", () => {
    it("splits loose datasets from per-folder groups, sorting folders", () => {
        const { loose, folders } = buildFolderTree([
            makeDataset({ name: "loose" }),
            makeDataset({ name: "zebra/a" }),
            makeDataset({ name: "anime/1girl" }),
            makeDataset({ name: "anime/2girls" }),
        ]);
        expect(loose.map((d) => d.name)).toEqual(["loose"]);
        expect(folders.map((g) => g.path)).toEqual(["anime", "zebra"]);
        expect(folders[0].items.map((d) => d.name)).toEqual([
            "anime/1girl",
            "anime/2girls",
        ]);
    });

    it("nests multi-segment paths under intermediate folders", () => {
        const { folders } = buildFolderTree([
            makeDataset({ name: "tags/X779.Danbooruwildcards/foo" }),
            makeDataset({ name: "tags/plain" }),
        ]);
        expect(folders.map((f) => f.path)).toEqual(["tags"]);
        const tags = folders[0];
        // The sub-folder nests inside "tags" instead of becoming a sibling.
        expect(tags.folders.map((f) => f.path)).toEqual([
            "tags/X779.Danbooruwildcards",
        ]);
        expect(tags.name).toBe("tags");
        expect(tags.folders[0].name).toBe("X779.Danbooruwildcards");
        expect(tags.items.map((d) => d.name)).toEqual(["tags/plain"]);
        expect(tags.folders[0].items.map((d) => d.name)).toEqual([
            "tags/X779.Danbooruwildcards/foo",
        ]);
    });

    it("yields no folders for a fully flat list", () => {
        const { loose, folders } = buildFolderTree([
            makeDataset({ name: "a" }),
            makeDataset({ name: "b" }),
        ]);
        expect(folders).toEqual([]);
        expect(loose).toHaveLength(2);
    });
});

describe("folderDatasetCount", () => {
    it("counts datasets across nested sub-folders", () => {
        const { folders } = buildFolderTree([
            makeDataset({ name: "tags/a" }),
            makeDataset({ name: "tags/sub/b" }),
            makeDataset({ name: "tags/sub/c" }),
        ]);
        expect(folderDatasetCount(folders[0])).toBe(3);
    });
});

describe("allAncestorsExpanded", () => {
    it("is true only when every ancestor folder is expanded", () => {
        const expanded = new Set(["tags"]);
        expect(allAncestorsExpanded(null, expanded)).toBe(true);
        expect(allAncestorsExpanded("tags", expanded)).toBe(true);
        expect(allAncestorsExpanded("tags/sub", expanded)).toBe(false);
        expect(
            allAncestorsExpanded("tags/sub", new Set(["tags", "tags/sub"])),
        ).toBe(true);
    });
});

describe("renderPreviewTable", () => {
    it("shows a hint when there are no columns", () => {
        expect(renderPreviewTable([], [])).toContain("No columns");
    });

    it("renders a header and one row per record", () => {
        const html = renderPreviewTable(
            ["prompt", "tags"],
            [
                ["a girl", "[brunette, punk]"],
                ["a boy", "[blonde]"],
            ],
        );
        expect(html).toContain("<th>prompt</th>");
        expect(html).toContain("<th>tags</th>");
        expect(html).toContain("<td>a girl</td>");
        expect(html).toContain("<td>[brunette, punk]</td>");
        expect(html).toContain("<td>a boy</td>");
    });

    it("escapes column names and cell values", () => {
        const html = renderPreviewTable(
            ["<col>"],
            [["<script>alert(1)</script>"]],
        );
        expect(html).toContain("&lt;col&gt;");
        expect(html).toContain("&lt;script&gt;");
        expect(html).not.toContain("<script>");
    });

    it("fills missing cells with empty strings", () => {
        const html = renderPreviewTable(["a", "b"], [["only-a"]]);
        expect(html).toContain("<td>only-a</td>");
        expect(html).toContain("<td></td>");
    });

    it("shows a no-rows hint when columns exist but rows are empty", () => {
        const html = renderPreviewTable(["a"], []);
        expect(html).toContain("No rows");
        expect(html).toContain("<th>a</th>");
    });
});

describe("PREVIEW_ROW_LIMIT", () => {
    it("is 100", () => {
        expect(PREVIEW_ROW_LIMIT).toBe(100);
    });
});

describe("renderPreviewStatus", () => {
    it("shows the loaded count out of the total, with separators", () => {
        expect(renderPreviewStatus(600, 1234)).toBe(
            "Showing 600 of 1,234 row(s).",
        );
    });

    it("omits the total when the row count is unknown", () => {
        expect(renderPreviewStatus(50, null)).toBe("Showing 50 row(s).");
        expect(renderPreviewStatus(1000, undefined)).toBe(
            "Showing 1,000 row(s).",
        );
    });
});

describe("renderEnableToggle", () => {
    it("renders an enabled switch reflecting checked state", () => {
        const html = renderEnableToggle("prompts/1girl", true);
        expect(html).toContain("quarry-dataset-enable");
        expect(html).toContain("quarry-enabled");
        expect(html).toContain('aria-checked="true"');
        expect(html).toContain('data-dataset="prompts/1girl"');
        expect(html).toContain('role="switch"');
    });

    it("renders a disabled switch reflecting unchecked state", () => {
        const html = renderEnableToggle("a", false);
        expect(html).toContain("quarry-disabled");
        expect(html).toContain('aria-checked="false"');
    });

    it("escapes the dataset name", () => {
        expect(renderEnableToggle('a"b', true)).toContain(
            'data-dataset="a&quot;b"',
        );
    });
});

describe("isDatasetEnabled", () => {
    it("treats a missing flag as enabled", () => {
        expect(isDatasetEnabled(makeDataset({ name: "a" }))).toBe(true);
    });

    it("treats enabled:false as disabled", () => {
        expect(
            isDatasetEnabled(makeDataset({ name: "a", enabled: false })),
        ).toBe(false);
    });

    it("treats enabled:true as enabled", () => {
        expect(
            isDatasetEnabled(makeDataset({ name: "a", enabled: true })),
        ).toBe(true);
    });
});

describe("collectTagColumns", () => {
    it("reads each dataset's checked tag boxes, keeping unchecked datasets as empty", () => {
        const container = document.createElement("div");
        container.innerHTML = `
            <label><input type="checkbox" class="quarry-dataset-tag" data-dataset="a" value="bar" checked></label>
            <label><input type="checkbox" class="quarry-dataset-tag" data-dataset="a" value="baz" checked></label>
            <label><input type="checkbox" class="quarry-dataset-tag" data-dataset="a" value="qux"></label>
            <label><input type="checkbox" class="quarry-dataset-tag" data-dataset="b" value="z"></label>`;
        expect(collectTagColumns(container)).toEqual({
            a: ["bar", "baz"],
            b: [],
        });
    });

    it("ignores tag boxes without a data-dataset attribute", () => {
        const container = document.createElement("div");
        container.innerHTML = `<label><input type="checkbox" class="quarry-dataset-tag" value="x" checked></label>`;
        expect(collectTagColumns(container)).toEqual({});
    });
});
