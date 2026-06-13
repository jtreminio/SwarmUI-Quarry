import { describe, expect, it } from "@jest/globals";
import {
    collectPromptColumns,
    escapeHtml,
    formatRowCount,
    PREVIEW_ROW_LIMIT,
    renderDatasetRow,
    renderDatasets,
    renderPreviewTable,
    renderStatus,
} from "./settings";

describe("escapeHtml", () => {
    it("escapes angle brackets and ampersands", () => {
        expect(escapeHtml("<script>&")).toBe("&lt;script&gt;&amp;");
    });
});

describe("renderStatus", () => {
    it("active shows the count", () => {
        const html = renderStatus(true, 3);
        expect(html).toContain("Active");
        expect(html).toContain("3");
    });

    it("inactive shows a hint", () => {
        expect(renderStatus(false, 0)).toContain("Inactive");
    });
});

describe("renderDatasetRow", () => {
    it("pre-selects the resolved column and badges list columns", () => {
        const html = renderDatasetRow({
            name: "prompts/1girl",
            columns: [
                { name: "prompt", kind: "scalar" },
                { name: "tags", kind: "list" },
            ],
            resolvedPromptColumn: "prompt",
            configuredPromptColumn: null,
            rowCount: 1234,
            error: null,
        });
        expect(html).toContain("prompts/1girl");
        expect(html).toContain('value="prompt" selected');
        expect(html).toContain("tags [list]");
        expect(html).toContain('data-dataset="prompts/1girl"');
    });

    it("renders an error row when the schema failed", () => {
        const html = renderDatasetRow({
            name: "bad",
            columns: [],
            resolvedPromptColumn: null,
            configuredPromptColumn: null,
            rowCount: null,
            error: "boom",
        });
        expect(html).toContain("quarry-dataset-error");
        expect(html).toContain("boom");
    });

    it("includes a preview button targeting the dataset", () => {
        const html = renderDatasetRow({
            name: "prompts/1girl",
            columns: [{ name: "prompt", kind: "scalar" }],
            resolvedPromptColumn: "prompt",
            configuredPromptColumn: null,
            rowCount: 1234,
            error: null,
        });
        expect(html).toContain("quarry-preview-button");
        expect(html).toContain('data-dataset="prompts/1girl"');
        expect(html).toContain("Preview");
    });

    it("shows the row count, formatted with separators", () => {
        const html = renderDatasetRow({
            name: "big",
            columns: [{ name: "prompt", kind: "scalar" }],
            resolvedPromptColumn: "prompt",
            configuredPromptColumn: null,
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
            rowCount: null,
            error: "boom",
        });
        expect(html).not.toContain("quarry-preview-button");
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
                rowCount: 10,
                error: null,
            },
            {
                name: "b",
                columns: [{ name: "q", kind: "scalar" }],
                resolvedPromptColumn: "q",
                configuredPromptColumn: null,
                rowCount: 20,
                error: null,
            },
        ]);
        expect(html).toContain("quarry-datasets-table");
        expect(html).toContain("<thead>");
        expect(html).toContain("<th>Rows</th>");
        expect(html).toContain('data-dataset="a"');
        expect(html).toContain('data-dataset="b"');
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

describe("collectPromptColumns", () => {
    it("reads each select's value keyed by dataset name", () => {
        const container = document.createElement("div");
        container.innerHTML = `
            <select class="quarry-dataset-column" data-dataset="a">
                <option value="x">x</option>
                <option value="y" selected>y</option>
            </select>
            <select class="quarry-dataset-column" data-dataset="b">
                <option value="z" selected>z</option>
            </select>`;
        expect(collectPromptColumns(container)).toEqual({ a: "y", b: "z" });
    });

    it("ignores selects without a data-dataset attribute", () => {
        const container = document.createElement("div");
        container.innerHTML = `<select class="quarry-dataset-column"><option value="x" selected>x</option></select>`;
        expect(collectPromptColumns(container)).toEqual({});
    });
});
