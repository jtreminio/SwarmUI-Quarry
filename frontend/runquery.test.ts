import { describe, expect, it } from "@jest/globals";
import {
    clampMaxResults,
    highlightPrompt,
    RUNQUERY_DEFAULT_MAX,
    RUNQUERY_MIN_MAX,
    renderRunQueryDatasetCounts,
    renderRunQueryResponse,
    renderRunQueryResults,
    runQuerySummaryText,
} from "./runquery";

describe("runquery limits", () => {
    it("defaults to 25 with a floor of 1", () => {
        expect(RUNQUERY_DEFAULT_MAX).toBe(25);
        expect(RUNQUERY_MIN_MAX).toBe(1);
    });
});

describe("clampMaxResults", () => {
    it("parses a numeric string", () => {
        expect(clampMaxResults("50")).toBe(50);
    });

    it("accepts a number directly", () => {
        expect(clampMaxResults(100)).toBe(100);
    });

    it("falls back to the default for empty, null, or garbage input", () => {
        expect(clampMaxResults("")).toBe(RUNQUERY_DEFAULT_MAX);
        expect(clampMaxResults(null)).toBe(RUNQUERY_DEFAULT_MAX);
        expect(clampMaxResults(undefined)).toBe(RUNQUERY_DEFAULT_MAX);
        expect(clampMaxResults("abc")).toBe(RUNQUERY_DEFAULT_MAX);
    });

    it("treats zero and negatives as unset", () => {
        expect(clampMaxResults(0)).toBe(RUNQUERY_DEFAULT_MAX);
        expect(clampMaxResults("-5")).toBe(RUNQUERY_DEFAULT_MAX);
    });

    it("honors any positive count with no upper cap", () => {
        expect(clampMaxResults(9999)).toBe(9999);
        expect(clampMaxResults("10000")).toBe(10000);
        expect(clampMaxResults(1_000_000)).toBe(1_000_000);
    });

    it("truncates fractional values", () => {
        expect(clampMaxResults(12.9)).toBe(12);
    });
});

describe("runQuerySummaryText", () => {
    it("pluralizes matches and datasets with separators", () => {
        expect(runQuerySummaryText(1234, 3, 25, false)).toBe(
            "1,234 matches across 3 datasets",
        );
    });

    it("singularizes a lone match in a lone dataset", () => {
        expect(runQuerySummaryText(1, 1, 1, false)).toBe(
            "1 match across 1 dataset",
        );
    });

    it("notes truncation with the shown count", () => {
        expect(runQuerySummaryText(1234, 3, 25, true)).toBe(
            "1,234 matches across 3 datasets · showing the first 25",
        );
    });

    it("handles zero matches", () => {
        expect(runQuerySummaryText(0, 0, 0, false)).toBe(
            "0 matches across 0 datasets",
        );
    });
});

describe("renderRunQueryDatasetCounts", () => {
    it("renders one item per dataset with its formatted count", () => {
        const html = renderRunQueryDatasetCounts([
            { name: "tags/1girl", matches: 12345 },
            { name: "loose", matches: 2 },
        ]);
        expect(html).toContain("quarry-runquery-datasets");
        expect(html).toContain(
            '<span class="quarry-runquery-dataset-name">tags/1girl</span>',
        );
        expect(html).toContain(
            '<span class="quarry-runquery-dataset-count">12,345</span>',
        );
        expect(html).toContain(">loose</span>");
        expect(html).toContain(">2</span>");
    });

    it("escapes dataset names", () => {
        const html = renderRunQueryDatasetCounts([
            { name: "<b>&", matches: 1 },
        ]);
        expect(html).toContain("&lt;b&gt;&amp;");
        expect(html).not.toContain("<b>&");
    });

    it("renders nothing for an empty list", () => {
        expect(renderRunQueryDatasetCounts([])).toBe("");
    });
});

describe("renderRunQueryResults", () => {
    it("puts each prompt under its dataset heading, with no dataset column", () => {
        const html = renderRunQueryResults([
            { dataset: "tags/1girl", prompt: "a girl, smiling" },
            { dataset: "loose", prompt: "a boy" },
        ]);
        expect(html).toContain("quarry-runquery-table");
        expect(html).toContain(
            '<div class="quarry-runquery-dataset-heading">tags/1girl</div>',
        );
        expect(html).toContain(
            '<div class="quarry-runquery-dataset-heading">loose</div>',
        );
        expect(html).toContain(
            '<div class="quarry-runquery-prompt-text">a girl, smiling</div>',
        );
        expect(html).toContain(">a boy</div>");
        expect(html).not.toContain("quarry-runquery-result-dataset");
    });

    it("emits one heading and one table per dataset, not per row", () => {
        const html = renderRunQueryResults([
            { dataset: "a", prompt: "one" },
            { dataset: "a", prompt: "two" },
            { dataset: "b", prompt: "three" },
        ]);
        expect(
            html.match(/quarry-runquery-dataset-heading/g) ?? [],
        ).toHaveLength(2);
        expect(html.match(/quarry-runquery-table/g) ?? []).toHaveLength(2);
    });

    it("gives every row a copy button", () => {
        const html = renderRunQueryResults([
            { dataset: "a", prompt: "one" },
            { dataset: "b", prompt: "two" },
        ]);
        const buttons = html.match(/quarry-runquery-copy/g) ?? [];
        expect(buttons).toHaveLength(2);
        expect(html).toContain('title="Copy prompt"');
    });

    it("marks the highlight terms inside each prompt", () => {
        const html = renderRunQueryResults(
            [{ dataset: "a", prompt: "1girl, smiling" }],
            ["girl"],
        );
        expect(html).toContain('<mark class="quarry-runquery-hl">girl</mark>');
    });

    it("escapes dataset names and prompt text", () => {
        const html = renderRunQueryResults([
            { dataset: "<x>", prompt: "<script>alert(1)</script>" },
        ]);
        expect(html).toContain("&lt;x&gt;");
        expect(html).toContain("&lt;script&gt;");
        expect(html).not.toContain("<script>");
    });

    it("shows a hint when there are no rows", () => {
        expect(renderRunQueryResults([])).toContain("No matching rows");
    });
});

describe("highlightPrompt", () => {
    it("escapes the text and adds no marks when there are no terms", () => {
        expect(highlightPrompt("a <b> & c", [])).toBe("a &lt;b&gt; &amp; c");
    });

    it("wraps a case-insensitive match without altering surrounding text", () => {
        expect(highlightPrompt("A Girl and a GIRL", ["girl"])).toBe(
            'A <mark class="quarry-runquery-hl">Girl</mark> and a ' +
                '<mark class="quarry-runquery-hl">GIRL</mark>',
        );
    });

    it("prefers the longest term at a shared start position", () => {
        expect(
            highlightPrompt("final fantasy vii", ["final", "final fantasy"]),
        ).toBe('<mark class="quarry-runquery-hl">final fantasy</mark> vii');
    });

    it("escapes both the match and the gaps around it", () => {
        expect(highlightPrompt("<x> girl <y>", ["girl"])).toBe(
            '&lt;x&gt; <mark class="quarry-runquery-hl">girl</mark> &lt;y&gt;',
        );
    });

    it("treats terms as literals, not regex", () => {
        expect(highlightPrompt("a.b a+b", ["a.b"])).toBe(
            '<mark class="quarry-runquery-hl">a.b</mark> a+b',
        );
    });
});

describe("renderRunQueryResponse", () => {
    it("renders an invalid-input notice without a summary", () => {
        const html = renderRunQueryResponse({ invalid: "bad <syntax>" });
        expect(html).toContain("quarry-runquery-invalid");
        expect(html).toContain("bad &lt;syntax&gt;");
        expect(html).not.toContain("quarry-runquery-summary");
    });

    it("renders unexpected errors with the error style", () => {
        const html = renderRunQueryResponse({ error: "boom" });
        expect(html).toContain("quarry-preview-error");
        expect(html).toContain("boom");
    });

    it("renders summary, dataset counts, and result rows on success", () => {
        const html = renderRunQueryResponse({
            total: 3,
            datasets: [
                { name: "a", matches: 2 },
                { name: "b", matches: 1 },
            ],
            results: [
                { dataset: "a", prompt: "one" },
                { dataset: "a", prompt: "two" },
                { dataset: "b", prompt: "three" },
            ],
            truncated: false,
        });
        expect(html).toContain("3 matches across 2 datasets");
        expect(html).toContain("quarry-runquery-datasets");
        expect(html).toContain("quarry-runquery-table");
        expect(html).toContain(">one</div>");
        expect(html).toContain(">three</div>");
        expect(html).not.toContain("showing the first");
    });

    it("notes truncation when the backend flags it", () => {
        const html = renderRunQueryResponse({
            total: 100,
            datasets: [{ name: "a", matches: 100 }],
            results: [{ dataset: "a", prompt: "one" }],
            truncated: true,
        });
        expect(html).toContain("100 matches across 1 dataset");
        expect(html).toContain("showing the first 1");
    });

    it("tolerates a sparse success payload", () => {
        const html = renderRunQueryResponse({});
        expect(html).toContain("0 matches across 0 datasets");
        expect(html).toContain("No matching rows");
    });
});
