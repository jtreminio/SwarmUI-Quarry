import { afterEach, describe, expect, it, jest } from "@jest/globals";
import datasetSources from "../dataset-sources.json";
import {
    openDownloadModal,
    progressPercent,
    renderProgressInfo,
    renderRemoteDatasetName,
    renderRemoteDatasetRow,
    renderRemoteDatasets,
    renderRemoteFolderHeaderRow,
    sourceRepoUrl,
} from "./download";
import type { RemoteDatasetDto } from "./types";
import { type FolderNode, formatBytes } from "./util";

const makeRemote = (name: string, installed = false): RemoteDatasetDto => ({
    name,
    repoPath: `${name}.lance`,
    sizeBytes: 100,
    fileCount: 1,
    installed,
});

describe("renderRemoteDatasetRow", () => {
    it("shows update messaging only for installed datasets with an update", () => {
        const dataset = {
            ...makeRemote("org.repo", true),
            updateAvailable: true,
        };
        const html = renderRemoteDatasetRow(dataset);
        expect(html).toContain("Update available!");
        expect(html).toContain('data-update="true"');
        expect(html).toContain("quarry-remote-check");
        expect(
            renderRemoteDatasetRow({ ...dataset, installed: false }),
        ).not.toContain("Update available!");
        expect(
            renderRemoteDatasetRow(makeRemote("org.repo", true)),
        ).not.toContain("Update available!");
    });
    it("renders a not-installed dataset with an unchecked selection checkbox", () => {
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
        // A selection checkbox, flagged not-installed, with no per-row download button.
        expect(html).toContain("quarry-remote-select");
        expect(html).toContain('data-installed="false"');
        expect(html).not.toContain(">Download<");
        expect(html).not.toContain(">Redownload<");
        expect(html).toContain("9.8 MB");
        // The file count is intentionally not shown.
        expect(html).not.toContain("file");
        expect(html).not.toContain("quarry-remote-installed");
        expect(html).not.toContain("✓");
    });

    it("renders an installed dataset with a checkmark and a pre-set redownload flag", () => {
        const html = renderRemoteDatasetRow({
            name: "DamarJati.SD-Prompts",
            repoPath: "DamarJati.SD-Prompts.lance",
            sizeBytes: 22208,
            fileCount: 1,
            installed: true,
        });
        expect(html).toContain("quarry-remote-installed");
        expect(html).toContain("quarry-remote-check");
        expect(html).toContain("✓");
        expect(html).toContain('data-installed="true"');
        expect(html).not.toContain(">Redownload<");
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
    it("counts updates in collapsed categories including nested folders", () => {
        const html = renderRemoteDatasets([
            { ...makeRemote("nl/org.one", true), updateAvailable: true },
            { ...makeRemote("nl/sub/org.two", true), updateAvailable: true },
            makeRemote("nl/org.three", true),
        ]);
        const container = document.createElement("div");
        container.innerHTML = html;
        expect(
            container.querySelector('[data-folder="nl"]')?.textContent,
        ).toContain("2 updates available!");
        expect(
            container.querySelector('[data-folder="nl/sub"]')?.textContent,
        ).toContain("1 update available!");
    });
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

    it("groups nested datasets under a collapsible folder header (collapsed by default)", () => {
        const html = renderRemoteDatasets([
            makeRemote("loose"),
            makeRemote("X779.Danbooruwildcards/DTR2024_1boy"),
            makeRemote("X779.Danbooruwildcards/DTR2024_1girl"),
        ]);
        // A collapsible folder header row, collapsed by default, with a 3-column-wide header and a count of 2.
        expect(html).toContain('class="quarry-folder-row quarry-collapsed"');
        expect(html).toContain('data-folder="X779.Danbooruwildcards"');
        expect(html).toContain("quarry-folder-toggle");
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('colspan="3"');
        // Member rows keep the full name in data-dataset but display only the leaf.
        expect(html).toContain(
            'data-dataset="X779.Danbooruwildcards/DTR2024_1boy"',
        );
        expect(html).toContain(">DTR2024_1boy</a>");
        expect(html).not.toContain(">X779.Danbooruwildcards/DTR2024_1boy</a>");
        // The top-level dataset stays loose (not wrapped in a folder group's name link).
        expect(html).toContain('data-dataset="loose"');
    });

    it("renders a folder expanded when it is named in the expanded set", () => {
        const html = renderRemoteDatasets(
            [makeRemote("anime/1girl")],
            new Set(["anime"]),
        );
        expect(html).toContain('class="quarry-folder-row"');
        expect(html).not.toContain("quarry-collapsed");
        expect(html).toContain('aria-expanded="true"');
    });

    it("nests a sub-folder inside its parent rather than beside it", () => {
        const html = renderRemoteDatasets([
            makeRemote("tags/X779.Danbooruwildcards/DTR2024_1girl"),
        ]);
        expect(html).toContain('data-folder="tags"');
        expect(html).toContain(
            'data-folder="tags/X779.Danbooruwildcards" data-parent="tags"',
        );
        expect(html).toContain(
            'data-dataset="tags/X779.Danbooruwildcards/DTR2024_1girl" data-parent="tags/X779.Danbooruwildcards"',
        );
        expect(html).toContain(">DTR2024_1girl</a>");
        expect(html).toContain(
            'href="https://huggingface.co/datasets/X779/Danbooruwildcards"',
        );
        expect(html).not.toContain('href="https://huggingface.co/tags"');
    });
});

describe("renderRemoteFolderHeaderRow", () => {
    const node: FolderNode<RemoteDatasetDto> = {
        path: "anime",
        name: "anime",
        folders: [],
        items: [makeRemote("anime/1girl"), makeRemote("anime/2girls")],
    };

    it("renders a 3-column header row with a recursive dataset count", () => {
        const html = renderRemoteFolderHeaderRow(node, 0, new Set(["anime"]));
        expect(html).toContain('class="quarry-folder-row"');
        expect(html).toContain('colspan="3"');
        expect(html).toContain('aria-expanded="true"');
        expect(html).toContain('<span class="quarry-folder-name">anime</span>');
        expect(html).toContain('title="2 dataset(s)"');
    });

    it("marks the header collapsed when not expanded", () => {
        const html = renderRemoteFolderHeaderRow(node, 0, new Set());
        expect(html).toContain("quarry-collapsed");
        expect(html).toContain('aria-expanded="false"');
    });
});

describe("sourceRepoUrl", () => {
    it.each(
        datasetSources,
    )("uses verified attribution for $name and its optional alias", (entry) => {
        for (const name of [entry.name, entry.alias]) {
            if (name == null) {
                continue;
            }
            expect(sourceRepoUrl(name)).toBe(entry.sourceUrl);
            expect(sourceRepoUrl(name.toUpperCase())).toBe(entry.sourceUrl);
            expect(sourceRepoUrl(name.split("/").pop())).toBe(entry.sourceUrl);
        }
    });

    it("credits jgreely on GitHub and keeps sources without URLs unlinked", () => {
        expect(sourceRepoUrl("nl/jgreely-c1ga")).toBe(
            "https://github.com/jgreely/c1ga",
        );
        expect(sourceRepoUrl("nl/jgreely.c1ga")).toBe(
            "https://github.com/jgreely/c1ga",
        );
        expect(sourceRepoUrl("tags/CyberHarem")).toBe(
            "https://huggingface.co/CyberHarem",
        );
        expect(sourceRepoUrl("tags/civitai.author_prompts")).toBeNull();
        expect(sourceRepoUrl("tags/civitai")).toBeNull();
        expect(sourceRepoUrl("tags/moescape")).toBeNull();
    });

    it("infers an uncataloged dataset's source repo", () => {
        expect(sourceRepoUrl("example-org.example-repo")).toBe(
            "https://huggingface.co/datasets/example-org/example-repo",
        );
    });

    it.each([
        ["org.repo.foldername", "org/repo"],
        ["tags/org.repo/leaf", "org/repo"],
        ["short-stories/org.repo", "org/repo"],
        ["category/subcategory/org.repo.folder/leaf", "org/repo"],
        ["org.repo/leaf.with.dots", "org/repo"],
    ])("derives the source repo from %s, ignoring categories and subset details", (name, repo) => {
        expect(sourceRepoUrl(name)).toBe(
            `https://huggingface.co/datasets/${repo}`,
        );
    });

    it.each([
        "",
        ".leading",
        "trailing.",
        "org..folder",
        "short-stories/unknown-story",
    ])("returns null for %s without an org.repo name", (name) => {
        expect(sourceRepoUrl(name)).toBeNull();
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

    it("links a nested dataset to its top-level source repo while showing the full name", () => {
        const html = renderRemoteDatasetName(
            "X779.Danbooruwildcards/DTR2024_1boy",
        );
        expect(html).toContain(
            'href="https://huggingface.co/datasets/X779/Danbooruwildcards"',
        );
        expect(html).toContain(">X779.Danbooruwildcards/DTR2024_1boy</a>");
    });

    it("leaves dot-less names as plain text instead of guessing an org page", () => {
        expect(renderRemoteDatasetName("tags/moescape", "moescape")).toBe(
            "moescape",
        );
    });

    it("links a categorized subset to its original repo while preserving the display name", () => {
        const html = renderRemoteDatasetName(
            "nl/codeShare.chroma_prompts.anime_captions",
            "codeShare.chroma_prompts.anime_captions",
        );
        expect(html).toContain(
            'href="https://huggingface.co/datasets/codeShare/chroma_prompts"',
        );
        expect(html).toContain('rel="noreferrer noopener"');
        expect(html).toContain(">codeShare.chroma_prompts.anime_captions</a>");
    });

    it("escapes the name in both the link and its title", () => {
        const evil = renderRemoteDatasetName("<evil>");
        expect(evil).toContain("&lt;evil&gt;");
        expect(evil).not.toContain("<evil>");
    });

    it("falls back to plain escaped text when no source repo can be derived", () => {
        expect(renderRemoteDatasetName("trailing.")).toBe("trailing.");
        const evil = renderRemoteDatasetName(".<evil>");
        expect(evil).toBe(".&lt;evil&gt;");
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

describe("download update selection", () => {
    afterEach(() => {
        Reflect.deleteProperty(globalThis, "genericRequest");
    });

    const setup = (outcome: "done" | "error" | "cancelled" = "done") => {
        const datasets = [
            { ...makeRemote("nl/org.update", true), updateAvailable: true },
            makeRemote("nl/org.installed", true),
            makeRemote("nl/org.new"),
        ];
        const downloads: Record<string, unknown>[] = [];
        let active = false;
        let refresh: unknown = false;
        globalThis.genericRequest = <T>(
            endpoint: string,
            data: Record<string, unknown>,
            callback: (data: T) => void,
        ) => {
            let response: unknown;
            if (endpoint === "QuarryListAvailableDatasets") {
                refresh = data.refresh;
                response = { success: true, datasets, tokenSet: true };
            } else if (endpoint === "QuarryDownloadDataset") {
                downloads.push(data);
                active = true;
                response = { success: true, id: 1 };
            } else {
                response = {
                    success: true,
                    active: false,
                    id: 1,
                    state: active ? outcome : "idle",
                    error: outcome === "error" ? "Download failed" : undefined,
                };
            }
            callback(response as T);
        };
        const changed = jest.fn();
        openDownloadModal(changed);
        return { downloads, changed, refreshed: () => refresh };
    };

    it("selects only updates in collapsed folders and clears badges after success", () => {
        const { downloads, changed, refreshed } = setup();
        document
            .querySelector<HTMLButtonElement>(".quarry-select-updates")
            ?.click();
        const selected = document.querySelectorAll<HTMLInputElement>(
            ".quarry-remote-select:checked",
        );
        expect(selected).toHaveLength(1);
        expect(selected[0].dataset.dataset).toBe("nl/org.update");
        const start = document.getElementById(
            "quarry-download-start",
        ) as HTMLButtonElement;
        expect(start.textContent).toBe("Update selected");
        expect(start.disabled).toBe(false);
        start.click();
        expect(downloads).toEqual([
            { dataset: "nl/org.update", redownload: true },
        ]);
        expect(document.querySelector(".quarry-remote-update")).toBeNull();
        expect(changed).toHaveBeenCalledTimes(1);
        document.getElementById("quarry-download-refresh")?.click();
        expect(refreshed()).toBe(true);
    });

    it("uses Download selected for a mixture of new datasets and updates", () => {
        setup();
        document
            .querySelector<HTMLButtonElement>(".quarry-select-updates")
            ?.click();
        document
            .querySelector<HTMLInputElement>(
                '.quarry-remote-select[data-dataset="nl/org.new"]',
            )
            ?.click();
        expect(
            document.getElementById("quarry-download-start")?.textContent,
        ).toBe("Download selected");
    });

    it.each([
        "error",
        "cancelled",
    ] as const)("retains update badges after %s", (outcome) => {
        const { changed } = setup(outcome);
        document
            .querySelector<HTMLButtonElement>(".quarry-select-updates")
            ?.click();
        document.getElementById("quarry-download-start")?.click();
        expect(
            document.querySelector(".quarry-remote-row .quarry-remote-update")
                ?.textContent,
        ).toBe("Update available!");
        expect(changed).not.toHaveBeenCalled();
    });
});
