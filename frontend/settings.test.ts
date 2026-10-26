import { describe, expect, it } from "@jest/globals";
import {
    applyInPromptHighlights,
    collectTagColumns,
    datasetColumnSettings,
    datasetFolder,
    datasetLeafName,
    formatDatasetsSummary,
    formatRowCount,
    isDatasetEnabled,
    mountDatasetSettings,
    PREVIEW_ROW_LIMIT,
    quarry,
    renderDatasetRow,
    renderDatasetSettings,
    renderDatasets,
    renderEnableToggle,
    renderFolderHeaderRow,
    renderForm,
    renderPreviewStatus,
    renderPreviewTable,
} from "./settings";
import type { DatasetDto } from "./types";
import {
    allAncestorsExpanded,
    buildFolderTree,
    escapeHtml,
    type FolderNode,
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

describe("renderDatasetRow", () => {
    it("lists available columns without editable defaults or field-count labels", () => {
        const html = renderDatasetRow({
            name: "prompts/1girl",
            columns: [
                { name: "prompt", kind: "scalar" },
                { name: "tags", kind: "list" },
            ],
            resolvedPromptColumn: "prompt",
            configuredPromptColumn: null,
            configuredTagColumns: [],
            rowCount: 1234,
            error: null,
        });
        expect(html).toContain("prompts/1girl");
        expect(html).toContain("<span>prompt</span>, <span>tags</span>");
        expect(html).not.toContain("<select");
        expect(html).not.toContain('type="checkbox"');
        expect(html).not.toContain("quarry-field-count");
        expect(html).toContain('data-dataset="prompts/1girl"');
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

    it("renders an error row when the schema failed", () => {
        const html = renderDatasetRow({
            name: "bad",
            columns: [],
            resolvedPromptColumn: null,
            configuredPromptColumn: null,
            configuredTagColumns: [],
            rowCount: null,
            error: "boom",
        });
        expect(html).toContain("quarry-dataset-error");
        expect(html).toContain("boom");
    });

    it("includes an Explore button targeting the dataset", () => {
        const html = renderDatasetRow({
            name: "prompts/1girl",
            columns: [{ name: "prompt", kind: "scalar" }],
            resolvedPromptColumn: "prompt",
            configuredPromptColumn: null,
            configuredTagColumns: [],
            rowCount: 1234,
            error: null,
        });
        expect(html).toContain("quarry-preview-button");
        expect(html).toContain('data-dataset="prompts/1girl"');
        expect(html).toContain("Explore");
    });

    it("shows the row count, formatted with separators", () => {
        const html = renderDatasetRow({
            name: "big",
            columns: [{ name: "prompt", kind: "scalar" }],
            resolvedPromptColumn: "prompt",
            configuredPromptColumn: null,
            configuredTagColumns: [],
            rowCount: 1234567,
            error: null,
        });
        expect(html).toContain("quarry-dataset-rows");
        expect(html).toContain("1,234,567");
    });

    it("shows an em-dash when the row count is unknown", () => {
        const html = renderDatasetRow({
            name: "unknown",
            columns: [{ name: "prompt", kind: "scalar" }],
            resolvedPromptColumn: "prompt",
            configuredPromptColumn: null,
            configuredTagColumns: [],
            rowCount: null,
            error: null,
        });
        expect(html).toContain("quarry-dataset-rows");
        expect(html).toContain("—");
    });

    it("omits the preview button on error rows", () => {
        const html = renderDatasetRow({
            name: "bad",
            columns: [],
            resolvedPromptColumn: null,
            configuredPromptColumn: null,
            configuredTagColumns: [],
            rowCount: null,
            error: "boom",
        });
        expect(html).not.toContain("quarry-preview-button");
    });

    it("renders the dataset name as a clickable insert button", () => {
        const html = renderDatasetRow({
            name: "prompts/1girl",
            columns: [{ name: "prompt", kind: "scalar" }],
            resolvedPromptColumn: "prompt",
            configuredPromptColumn: null,
            configuredTagColumns: [],
            rowCount: 1,
            error: null,
        });
        expect(html).toContain(
            '<button type="button" class="quarry-dataset-name quarry-dataset-name-link" data-dataset="prompts/1girl"',
        );
    });

    it("keeps the name clickable even on error rows", () => {
        const html = renderDatasetRow({
            name: "bad",
            columns: [],
            resolvedPromptColumn: null,
            configuredPromptColumn: null,
            configuredTagColumns: [],
            rowCount: null,
            error: "boom",
        });
        expect(html).toContain("quarry-dataset-name-link");
        expect(html).toContain('data-dataset="bad"');
    });

    it("shows a passed display name as the label but keeps the full name as identity", () => {
        const html = renderDatasetRow(
            makeDataset({ name: "anime/1girl" }),
            "1girl",
        );
        // data-dataset (the identity used for <q:> tags, highlights, preview) stays the full name.
        expect(html).toContain('data-dataset="anime/1girl"');
        // The visible button label is the short leaf name.
        expect(html).toContain(
            'title="Add or remove this dataset in the prompt">1girl</button>',
        );
        expect(html).not.toContain(">anime/1girl</button>");
    });

    it("wraps the name in an actionable cell so the whole TD is clickable", () => {
        expect(renderDatasetRow(makeDataset({ name: "a" }))).toContain(
            '<td class="quarry-dataset-name-cell">',
        );
    });

    it("uses the actionable name cell on error rows too", () => {
        const html = renderDatasetRow(
            makeDataset({ name: "bad", columns: [], error: "boom" }),
        );
        expect(html).toContain('<td class="quarry-dataset-name-cell">');
    });
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

    it("escapes column names in the read-only catalog", () => {
        const html = renderDatasetRow(
            makeDataset({
                name: "safe",
                columns: [{ name: "<script>", kind: "scalar" }],
            }),
        );
        expect(html).toContain("<span>&lt;script&gt;</span>");
        expect(html).not.toContain("<script>");
    });
});

describe("formatDatasetsSummary", () => {
    it("sums rows and sizes across datasets", () => {
        expect(
            formatDatasetsSummary([
                makeDataset({ name: "a", rowCount: 1234, sizeBytes: 1500 }),
                makeDataset({
                    name: "b",
                    rowCount: 5000,
                    sizeBytes: 2_000_000,
                }),
            ]),
        ).toBe("2 datasets · 6,234 rows · 2.0 MB");
    });

    it("flags datasets whose row count is not yet known", () => {
        expect(
            formatDatasetsSummary([
                makeDataset({ name: "a", rowCount: 100, sizeBytes: 0 }),
                makeDataset({ name: "b", rowCount: null, sizeBytes: 0 }),
            ]),
        ).toBe("2 datasets · 100+ rows (1 not counted yet) · 0 B");
    });

    it("singularizes a lone dataset and tolerates missing sizes", () => {
        expect(
            formatDatasetsSummary([makeDataset({ name: "solo", rowCount: 7 })]),
        ).toBe("1 dataset · 7 rows · 0 B");
    });
});

describe("renderDatasets", () => {
    it("shows a hint when empty", () => {
        expect(renderDatasets([])).toContain("No datasets found");
    });

    it("renders one row per dataset inside a table", () => {
        const html = renderDatasets([
            {
                name: "a",
                columns: [{ name: "p", kind: "scalar" }],
                resolvedPromptColumn: "p",
                configuredPromptColumn: null,
                configuredTagColumns: [],
                rowCount: 10,
                error: null,
            },
            {
                name: "b",
                columns: [{ name: "q", kind: "scalar" }],
                resolvedPromptColumn: "q",
                configuredPromptColumn: null,
                configuredTagColumns: [],
                rowCount: 20,
                error: null,
            },
        ]);
        expect(html).toContain("quarry-datasets-table");
        expect(html).toContain("<thead>");
        const container = document.createElement("div");
        container.innerHTML = html;
        expect(
            [...container.querySelectorAll("th")].map(
                (cell) => cell.textContent,
            ),
        ).toContain("Rows");
        expect(html).toContain('data-dataset="a"');
        expect(html).toContain('data-dataset="b"');
    });

    it("renders a totals summary in the table footer", () => {
        const html = renderDatasets([
            makeDataset({ name: "a", rowCount: 10, sizeBytes: 1000 }),
            makeDataset({ name: "b", rowCount: 20, sizeBytes: 2000 }),
        ]);
        expect(html).toContain("<tfoot>");
        expect(html).toContain('id="quarry-datasets-summary"');
        expect(html).toContain("2 datasets · 30 rows · 3.0 KB");
    });

    it("groups foldered datasets under a collapsible header, collapsed by default", () => {
        const html = renderDatasets([
            makeDataset({ name: "anime/1girl" }),
            makeDataset({ name: "anime/2girls" }),
        ]);
        // A folder header row that starts collapsed, with the folder name and a count of its members.
        expect(html).toContain('class="quarry-folder-row quarry-collapsed"');
        expect(html).toContain('data-folder="anime"');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('<span class="quarry-folder-name">anime</span>');
        expect(html).toContain(
            '<span class="quarry-folder-count" title="2 dataset(s)">2</span>',
        );
        // Members show the short leaf name but keep the full identity.
        expect(html).toContain('data-dataset="anime/1girl"');
        expect(html).toContain(">1girl</button>");
    });

    it("renders a folder expanded when listed in expandedFolders", () => {
        const html = renderDatasets(
            [makeDataset({ name: "anime/1girl" })],
            new Set(["anime"]),
        );
        expect(html).toContain('class="quarry-folder-row"');
        expect(html).not.toContain("quarry-collapsed");
        expect(html).toContain('aria-expanded="true"');
    });

    it("nests a sub-folder inside its parent rather than beside it", () => {
        const html = renderDatasets([
            makeDataset({ name: "tags/X779.Danbooruwildcards/foo" }),
        ]);
        // The parent "tags" is top-level (no data-parent); the sub-folder lives under it.
        expect(html).toContain('data-folder="tags"');
        expect(html).toContain(
            'data-folder="tags/X779.Danbooruwildcards" data-parent="tags"',
        );
        // The dataset hangs off the full sub-folder path, not "tags".
        expect(html).toContain(
            'data-dataset="tags/X779.Danbooruwildcards/foo" data-parent="tags/X779.Danbooruwildcards"',
        );
        expect(html).toContain(">foo</button>");
    });

    it("keeps top-level datasets ungrouped alongside folder groups", () => {
        const html = renderDatasets([
            makeDataset({ name: "loose" }),
            makeDataset({ name: "anime/1girl" }),
        ]);
        // The folder group exists...
        expect(html).toContain('data-folder="anime"');
        // ...and the loose dataset is rendered without a folder header.
        expect(html).toContain('data-dataset="loose"');
        expect(html).toContain(">loose</button>");
    });

    it("sorts folder groups alphabetically", () => {
        const html = renderDatasets([
            makeDataset({ name: "zebra/a" }),
            makeDataset({ name: "alpha/a" }),
        ]);
        expect(html.indexOf('data-folder="alpha"')).toBeLessThan(
            html.indexOf('data-folder="zebra"'),
        );
    });

    it("escapes folder names", () => {
        const html = renderDatasets([makeDataset({ name: "a&<b/x" })]);
        expect(html).toContain('data-folder="a&amp;&lt;b"');
        expect(html).not.toContain('data-folder="a&<b"');
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

describe("renderFolderHeaderRow", () => {
    const node: FolderNode<DatasetDto> = {
        path: "anime",
        name: "anime",
        folders: [],
        items: [
            makeDataset({ name: "anime/1girl" }),
            makeDataset({ name: "anime/2girls" }),
        ],
    };

    it("renders an expanded header row with a recursive dataset count", () => {
        const html = renderFolderHeaderRow(node, 0, new Set(["anime"]));
        expect(html).toContain('class="quarry-folder-row"');
        expect(html).not.toContain("quarry-collapsed");
        expect(html).toContain('data-folder="anime"');
        expect(html).toContain('aria-expanded="true"');
        expect(html).toContain('<span class="quarry-folder-name">anime</span>');
        expect(html).toContain(
            '<span class="quarry-folder-count" title="2 dataset(s)">2</span>',
        );
    });

    it("marks the header collapsed when not in the expanded set", () => {
        const html = renderFolderHeaderRow(node, 0, new Set());
        expect(html).toContain("quarry-collapsed");
        expect(html).toContain('aria-expanded="false"');
    });
});

describe("formatRowCount", () => {
    it("formats with locale thousands separators", () => {
        expect(formatRowCount(1234567)).toBe("1,234,567");
    });

    it("returns an em-dash for null/undefined", () => {
        expect(formatRowCount(null)).toBe("—");
        expect(formatRowCount(undefined)).toBe("—");
    });

    it("renders zero as 0, not an em-dash", () => {
        expect(formatRowCount(0)).toBe("0");
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

describe("renderDatasetRow enable toggle", () => {
    it("renders the toggle enabled by default", () => {
        const html = renderDatasetRow(makeDataset({ name: "a" }));
        expect(html).toContain("quarry-dataset-enable-cell");
        expect(html).toContain('aria-checked="true"');
        expect(html).not.toContain("quarry-dataset-disabled");
    });

    it("marks the row and toggle disabled when enabled is false", () => {
        const html = renderDatasetRow(
            makeDataset({ name: "a", enabled: false }),
        );
        expect(html).toContain("quarry-dataset-disabled");
        expect(html).toContain('aria-checked="false"');
    });

    it("renders the toggle on error rows too", () => {
        const html = renderDatasetRow(
            makeDataset({
                name: "bad",
                columns: [],
                enabled: false,
                error: "boom",
            }),
        );
        expect(html).toContain("quarry-dataset-enable-cell");
        expect(html).toContain('aria-checked="false"');
        expect(html).toContain("quarry-dataset-disabled");
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

describe("applyInPromptHighlights", () => {
    const makeTable = (...names: string[]): HTMLElement => {
        const container = document.createElement("div");
        // Mirrors renderDatasetRow's <tr> shape; that the real markup carries data-dataset is covered by the
        // renderDatasets tests, so here we focus purely on the highlight toggling.
        container.innerHTML = `<table><tbody>${names
            .map(
                (name) =>
                    `<tr class="quarry-dataset-row" data-dataset="${name}"><td>${name}</td></tr>`,
            )
            .join("")}</tbody></table>`;
        return container;
    };

    const highlighted = (container: HTMLElement): string[] =>
        Array.from(container.querySelectorAll(".quarry-dataset-in-prompt")).map(
            (row) => row.getAttribute("data-dataset") ?? "",
        );

    it("flags only the referenced rows, case-insensitively", () => {
        const container = makeTable("prompts/a", "prompts/b", "prompts/c");
        applyInPromptHighlights(container, ["PROMPTS/A", "prompts/c"]);
        expect(highlighted(container)).toEqual(["prompts/a", "prompts/c"]);
    });

    it("clears flags when given an empty list", () => {
        const container = makeTable("prompts/a", "prompts/b");
        applyInPromptHighlights(container, ["prompts/a"]);
        applyInPromptHighlights(container, []);
        expect(highlighted(container)).toEqual([]);
    });
});
