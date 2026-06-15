import { describe, expect, it } from "@jest/globals";
import {
    progressPercent,
    renderProgressInfo,
    renderRemoteDatasetName,
    renderRemoteDatasetRow,
    renderRemoteDatasets,
    sourceRepoUrl,
} from "./download";
import { formatBytes } from "./util";

describe("renderRemoteDatasetRow", () => {
    it("renders a not-installed dataset with a Download button", () => {
        const html = renderRemoteDatasetRow({
            name: "Gustavosta.Stable-Diffusion-Prompts",
            repoPath: "Gustavosta.Stable-Diffusion-Prompts.lance",
            sizeBytes: 9763643,
            fileCount: 4,
            installed: false,
        });
        expect(html).toContain(
            'data-dataset="Gustavosta.Stable-Diffusion-Prompts"',
        );
        // The name links to the source HuggingFace repo it was built from.
        expect(html).toContain(
            'href="https://huggingface.co/datasets/Gustavosta/Stable-Diffusion-Prompts"',
        );
        expect(html).toContain(">Download<");
        expect(html).toContain('data-redownload="false"');
        expect(html).toContain("9.8 MB");
        // The file count is intentionally not shown.
        expect(html).not.toContain("file");
        expect(html).not.toContain("quarry-remote-installed");
        expect(html).not.toContain("quarry-remote-check");
    });

    it("renders an installed dataset with a checkmark and a Redownload button", () => {
        const html = renderRemoteDatasetRow({
            name: "DamarJati.SD-Prompts",
            repoPath: "DamarJati.SD-Prompts.lance",
            sizeBytes: 22208,
            fileCount: 1,
            installed: true,
        });
        expect(html).toContain("quarry-remote-installed");
        expect(html).toContain("quarry-remote-check");
        expect(html).toContain(">Redownload<");
        expect(html).toContain('data-redownload="true"');
        expect(html).toContain("22.2 KB");
    });

    it("escapes the dataset name", () => {
        const html = renderRemoteDatasetRow({
            name: "<evil>",
            repoPath: "<evil>.lance",
            sizeBytes: 0,
            fileCount: 2,
            installed: false,
        });
        expect(html).toContain("&lt;evil&gt;");
        expect(html).not.toContain("<evil>");
    });
});

describe("renderRemoteDatasets", () => {
    it("shows a hint when empty", () => {
        expect(renderRemoteDatasets([])).toContain("No datasets available");
    });

    it("renders a table with one row per dataset", () => {
        const html = renderRemoteDatasets([
            {
                name: "a",
                repoPath: "a.lance",
                sizeBytes: 100,
                fileCount: 1,
                installed: false,
            },
            {
                name: "b",
                repoPath: "b.lance",
                sizeBytes: 200,
                fileCount: 2,
                installed: true,
            },
        ]);
        expect(html).toContain("quarry-remote-table");
        expect(html).toContain('data-dataset="a"');
        expect(html).toContain('data-dataset="b"');
    });
});

describe("sourceRepoUrl", () => {
    it("maps a dataset name to its source repo by replacing the first dot with a slash", () => {
        expect(sourceRepoUrl("Gustavosta.Stable-Diffusion-Prompts")).toBe(
            "https://huggingface.co/datasets/Gustavosta/Stable-Diffusion-Prompts",
        );
        expect(sourceRepoUrl("succinctly.midjourney-prompts")).toBe(
            "https://huggingface.co/datasets/succinctly/midjourney-prompts",
        );
    });

    it("splits on the first dot only, leaving later dots in the repo name", () => {
        // HuggingFace org/user names never contain a dot, so the first dot is always the `/` separator;
        // any further dots belong to the repo name and are preserved.
        expect(sourceRepoUrl("org.repo.v2")).toBe(
            "https://huggingface.co/datasets/org/repo.v2",
        );
    });

    it("returns null when there is no usable separator dot", () => {
        expect(sourceRepoUrl("noseparator")).toBeNull();
        expect(sourceRepoUrl(".leading")).toBeNull();
        expect(sourceRepoUrl("trailing.")).toBeNull();
    });
});

describe("renderRemoteDatasetName", () => {
    it("links the name to its source HuggingFace repo, opening in a new tab", () => {
        const html = renderRemoteDatasetName("succinctly.midjourney-prompts");
        expect(html).toContain(
            'href="https://huggingface.co/datasets/succinctly/midjourney-prompts"',
        );
        expect(html).toContain('target="_blank"');
        expect(html).toContain(">succinctly.midjourney-prompts</a>");
    });

    it("falls back to plain escaped text when no source repo can be derived", () => {
        expect(renderRemoteDatasetName("plainname")).toBe("plainname");
        const evil = renderRemoteDatasetName("<evil>");
        expect(evil).toBe("&lt;evil&gt;");
        expect(evil).not.toContain("<a");
    });
});

describe("progressPercent", () => {
    it("returns 0 when the total is unknown", () => {
        expect(
            progressPercent({ success: true, bytesTotal: 0, bytesDone: 0 }),
        ).toBe(0);
    });

    it("rounds the ratio and clamps to 100", () => {
        expect(
            progressPercent({
                success: true,
                bytesDone: 1400,
                bytesTotal: 3400,
            }),
        ).toBe(41);
        expect(
            progressPercent({
                success: true,
                bytesDone: 9999,
                bytesTotal: 1000,
            }),
        ).toBe(100);
    });
});

describe("renderProgressInfo", () => {
    it("shows a starting/finalizing label for those phases", () => {
        expect(renderProgressInfo({ success: true, state: "starting" })).toBe(
            "Starting…",
        );
        expect(renderProgressInfo({ success: true, state: "finalizing" })).toBe(
            "Finalizing…",
        );
    });

    it("shows percent, sizes, speed, and file count while downloading", () => {
        const info = renderProgressInfo({
            success: true,
            state: "downloading",
            bytesDone: 1_400_000_000,
            bytesTotal: 3_400_000_000,
            perSecond: 12_000_000,
            filesDone: 3,
            filesTotal: 21,
        });
        expect(info).toContain("41%");
        expect(info).toContain("1.4 GB");
        expect(info).toContain("3.4 GB");
        expect(info).toContain("12.0 MB/s");
        expect(info).toContain("file 3/21");
    });

    it("omits the speed when it is zero", () => {
        const info = renderProgressInfo({
            success: true,
            state: "downloading",
            bytesDone: 100,
            bytesTotal: 200,
            perSecond: 0,
            filesTotal: 0,
        });
        expect(info).not.toContain("/s");
        expect(info).not.toContain("file ");
    });
});

describe("formatBytes", () => {
    it("formats across units", () => {
        expect(formatBytes(0)).toBe("0 B");
        expect(formatBytes(153)).toBe("153 B");
        expect(formatBytes(22208)).toBe("22.2 KB");
        expect(formatBytes(9763643)).toBe("9.8 MB");
        expect(formatBytes(340010000)).toBe("340 MB");
        expect(formatBytes(3417600000)).toBe("3.4 GB");
    });

    it("returns an em-dash for null/undefined/negative", () => {
        expect(formatBytes(null)).toBe("—");
        expect(formatBytes(undefined)).toBe("—");
        expect(formatBytes(-1)).toBe("—");
    });
});
