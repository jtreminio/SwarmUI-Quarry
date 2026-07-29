import { describe, expect, it } from "@jest/globals";
import {
    clampMaxResults,
    commonDatasetPrefix,
    formatShare,
    highlightPrompt,
    RUNQUERY_DEFAULT_MAX,
    RUNQUERY_MIN_MAX,
    renderRunQueryDatasetCounts,
    renderRunQueryResponse,
    renderRunQueryResults,
    renderRunQuerySummary,
    runQueryPoolText,
    runQueryPreviewText,
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

describe("runQueryPoolText", () => {
    it("pluralizes prompts and datasets with a separator", () => {
        expect(runQueryPoolText(1234, 3)).toBe("1,234 prompts · 3 datasets");
    });

    it("singularizes a lone prompt in a lone dataset", () => {
        expect(runQueryPoolText(1, 1)).toBe("1 prompt · 1 dataset");
    });

    it("names the shared folder when there is one", () => {
        expect(runQueryPoolText(1234, 3, "tags/")).toBe(
            "1,234 prompts · 3 datasets under tags/",
        );
    });

    it("handles zero matches", () => {
        expect(runQueryPoolText(0, 0)).toBe("0 prompts · 0 datasets");
    });
});

describe("runQueryPreviewText", () => {
    it("calls a truncated preview a sample, not a ranking", () => {
        expect(runQueryPreviewText(25, true)).toBe("25 sampled below");
    });

    it("says everything is shown when nothing was cut", () => {
        expect(runQueryPreviewText(3, false)).toBe("all 3 shown below");
    });

    it("says nothing when there are no rows", () => {
        expect(runQueryPreviewText(0, true)).toBe("");
    });
});

describe("commonDatasetPrefix", () => {
    it("finds the shared folder", () => {
        expect(
            commonDatasetPrefix(["tags/civitai", "tags/civitai.authors"]),
        ).toBe("tags/");
    });

    it("keeps only whole folder segments", () => {
        expect(commonDatasetPrefix(["tags/a/one", "tags/a/two"])).toBe(
            "tags/a/",
        );
    });

    it("returns nothing when the names diverge at the root", () => {
        expect(commonDatasetPrefix(["tags/a", "loose"])).toBe("");
    });

    it("returns nothing for a lone dataset", () => {
        expect(commonDatasetPrefix(["tags/a"])).toBe("");
    });

    it("never strips a whole name away", () => {
        expect(commonDatasetPrefix(["tags/a/", "tags/a/two"])).toBe("");
    });
});

describe("formatShare", () => {
    it("rounds to whole percents", () => {
        expect(formatShare(7164, 21211)).toBe("34%");
    });

    it("floors tiny shares at <1%", () => {
        expect(formatShare(1, 21211)).toBe("<1%");
    });

    it("returns nothing without a usable total", () => {
        expect(formatShare(5, 0)).toBe("");
        expect(formatShare(0, 10)).toBe("");
    });
});

describe("renderRunQuerySummary", () => {
    it("labels the pool and the preview on separate rows", () => {
        const html = renderRunQuerySummary(1234, 3, 25, true, "tags/");
        expect(html).toContain(">Pool</span>");
        expect(html).toContain("1,234 prompts · 3 datasets under tags/");
        expect(html).toContain(">Preview</span>");
        expect(html).toContain("25 sampled below");
        expect(html).not.toContain("showing the first");
    });

    it("drops the preview row when there is nothing to preview", () => {
        const html = renderRunQuerySummary(0, 0, 0, false);
        expect(html).toContain("0 prompts · 0 datasets");
        expect(html).not.toContain(">Preview</span>");
    });
});

describe("renderRunQueryDatasetCounts", () => {
    it("renders one row per dataset with its formatted count and share", () => {
        const html = renderRunQueryDatasetCounts([
            { name: "tags/1girl", matches: 12345 },
            { name: "loose", matches: 2 },
        ]);
        expect(html).toContain("quarry-runquery-datasets");
        expect(html.match(/quarry-runquery-dataset-row/g) ?? []).toHaveLength(
            2,
        );
        expect(html).toContain(">tags/1girl</span>");
        expect(html).toContain(
            '<span class="quarry-runquery-dataset-count">12,345</span>',
        );
        expect(html).toContain(
            '<span class="quarry-runquery-dataset-share">&lt;1%</span>',
        );
        expect(html).toContain(">loose</span>");
        expect(html).toContain(">2</span>");
    });

    it("strips the shared folder from the names but keeps it in the tooltip", () => {
        const html = renderRunQueryDatasetCounts([
            { name: "tags/civitai", matches: 3 },
            { name: "tags/moescape", matches: 1 },
        ]);
        expect(html).toContain('title="tags/civitai"');
        expect(html).toContain(">civitai</span>");
        expect(html).not.toContain(">tags/civitai</span>");
    });

    it("scales each bar against the largest dataset", () => {
        const html = renderRunQueryDatasetCounts([
            { name: "a", matches: 100 },
            { name: "b", matches: 25 },
        ]);
        expect(html).toContain('style="width: 100.0%"');
        expect(html).toContain('style="width: 25.0%"');
    });

    it("keeps a sliver of bar for a negligible share", () => {
        const html = renderRunQueryDatasetCounts([
            { name: "a", matches: 100000 },
            { name: "b", matches: 1 },
        ]);
        expect(html).toContain('style="width: 2.0%"');
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
        const view = renderRunQueryResponse({ invalid: "bad <syntax>" });
        expect(view.summary).toBe("");
        expect(view.body).toContain("quarry-runquery-invalid");
        expect(view.body).toContain("bad &lt;syntax&gt;");
    });

    it("renders unexpected errors with the error style", () => {
        const view = renderRunQueryResponse({ error: "boom" });
        expect(view.summary).toBe("");
        expect(view.body).toContain("quarry-preview-error");
        expect(view.body).toContain("boom");
    });

    it("splits the summary from the counts and rows on success", () => {
        const view = renderRunQueryResponse({
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
        expect(view.summary).toContain("3 prompts · 2 datasets");
        expect(view.summary).toContain("all 3 shown below");
        expect(view.summary).not.toContain("quarry-runquery-datasets");
        expect(view.body).toContain("quarry-runquery-datasets");
        expect(view.body).toContain("quarry-runquery-table");
        expect(view.body).toContain(">one</div>");
        expect(view.body).toContain(">three</div>");
        expect(view.body).not.toContain("quarry-runquery-summary");
    });

    it("notes truncation when the backend flags it", () => {
        const view = renderRunQueryResponse({
            total: 100,
            datasets: [{ name: "a", matches: 100 }],
            results: [{ dataset: "a", prompt: "one" }],
            truncated: true,
        });
        expect(view.summary).toContain("100 prompts · 1 dataset");
        expect(view.summary).toContain("1 sampled below");
    });

    it("tolerates a sparse success payload", () => {
        const view = renderRunQueryResponse({});
        expect(view.summary).toContain("0 prompts · 0 datasets");
        expect(view.body).toContain("No matching rows");
    });
});
