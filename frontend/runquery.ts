import type {
    RunQueryDatasetDto,
    RunQueryResponse,
    RunQueryResultDto,
} from "./types";
import { escapeHtml, escapeRegExp } from "./util";

export const RUNQUERY_DEFAULT_MAX = 25;
export const RUNQUERY_MIN_MAX = 1;

const MODAL_ID = "quarry-runquery-modal";
const QUERY_ID = "quarry-runquery-query";
const MAX_ID = "quarry-runquery-max";
const RUN_ID = "quarry-runquery-run";
const SUMMARY_ID = "quarry-runquery-summary";
const RESULTS_ID = "quarry-runquery-results";

const EXAMPLE_QUERY = "<q:tags/**[tags=girl; tags!=anthro]>";

export const clampMaxResults = (
    value: string | number | null | undefined,
): number => {
    const num =
        typeof value === "number"
            ? value
            : Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(num) || num <= 0) {
        return RUNQUERY_DEFAULT_MAX;
    }
    return Math.max(Math.trunc(num), RUNQUERY_MIN_MAX);
};

/** The shared `folder/` every dataset name starts with, if there is one. */
export const commonDatasetPrefix = (names: string[]): string => {
    if (names.length < 2) {
        return "";
    }
    let prefix = names[0];
    for (const name of names.slice(1)) {
        let at = 0;
        while (
            at < prefix.length &&
            at < name.length &&
            prefix[at] === name[at]
        ) {
            at++;
        }
        prefix = prefix.slice(0, at);
        if (prefix.length === 0) {
            return "";
        }
    }
    const slash = prefix.lastIndexOf("/");
    if (slash < 0) {
        return "";
    }
    const folder = prefix.slice(0, slash + 1);
    return names.every((name) => name.length > folder.length) ? folder : "";
};

export const runQueryPoolText = (
    total: number,
    datasetCount: number,
    prefix = "",
): string => {
    const prompts = `${total.toLocaleString()} prompt${total === 1 ? "" : "s"}`;
    const datasets = `${datasetCount.toLocaleString()} dataset${datasetCount === 1 ? "" : "s"}`;
    const scope = prefix ? ` under ${prefix}` : "";
    return `${prompts} · ${datasets}${scope}`;
};

export const runQueryPreviewText = (
    shown: number,
    truncated: boolean,
): string => {
    if (shown <= 0) {
        return "";
    }
    return truncated
        ? `${shown.toLocaleString()} sampled below`
        : `all ${shown.toLocaleString()} shown below`;
};

const summaryRow = (label: string, value: string): string =>
    `<div class="quarry-runquery-summary-row"><span class="quarry-runquery-summary-label">${label}</span><span class="quarry-runquery-summary-value">${escapeHtml(value)}</span></div>`;

export const renderRunQuerySummary = (
    total: number,
    datasetCount: number,
    shown: number,
    truncated: boolean,
    prefix = "",
): string => {
    const preview = runQueryPreviewText(shown, truncated);
    return `<div class="quarry-runquery-summary">${summaryRow(
        "Pool",
        runQueryPoolText(total, datasetCount, prefix),
    )}${preview ? summaryRow("Preview", preview) : ""}</div>`;
};

export const formatShare = (matches: number, total: number): string => {
    if (total <= 0 || matches <= 0) {
        return "";
    }
    const pct = (matches / total) * 100;
    return pct < 1 ? "<1%" : `${Math.round(pct)}%`;
};

const datasetRow = (
    dataset: RunQueryDatasetDto,
    prefix: string,
    total: number,
    max: number,
): string => {
    const shown = prefix ? dataset.name.slice(prefix.length) : dataset.name;
    const raw = max > 0 ? (dataset.matches / max) * 100 : 0;
    // Keep a sliver of bar for the long tail, so a tiny share never looks like a render bug.
    const width = raw > 0 ? Math.max(raw, 2) : 0;
    return `<div class="quarry-runquery-dataset-row"><span class="quarry-runquery-dataset-name" title="${escapeHtml(dataset.name)}">${escapeHtml(shown)}</span><span class="quarry-runquery-dataset-count">${dataset.matches.toLocaleString()}</span><span class="quarry-runquery-dataset-share">${escapeHtml(formatShare(dataset.matches, total))}</span><span class="quarry-runquery-dataset-bar"><span style="width: ${width.toFixed(1)}%"></span></span></div>`;
};

export const renderRunQueryDatasetCounts = (
    datasets: RunQueryDatasetDto[],
): string => {
    if (!datasets || datasets.length === 0) {
        return "";
    }
    const total = datasets.reduce((sum, dataset) => sum + dataset.matches, 0);
    const max = datasets.reduce(
        (best, dataset) => Math.max(best, dataset.matches),
        0,
    );
    const prefix = commonDatasetPrefix(datasets.map((dataset) => dataset.name));
    const rows = datasets
        .map((dataset) => datasetRow(dataset, prefix, total, max))
        .join("");
    return `<div class="quarry-runquery-datasets">${rows}</div>`;
};

const COPY_GLYPH = "&#x29C9;";

export const highlightPrompt = (
    prompt: string,
    highlights: string[],
): string => {
    const needles = (highlights ?? []).filter((term) => term.length > 0);
    if (needles.length === 0) {
        return escapeHtml(prompt);
    }
    const pattern = needles
        .slice()
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join("|");
    const regex = new RegExp(pattern, "gi");
    let out = "";
    let last = 0;
    for (const match of prompt.matchAll(regex)) {
        const start = match.index ?? 0;
        out += escapeHtml(prompt.slice(last, start));
        out += `<mark class="quarry-runquery-hl">${escapeHtml(match[0])}</mark>`;
        last = start + match[0].length;
    }
    out += escapeHtml(prompt.slice(last));
    return out;
};

const groupResultsByDataset = (
    results: RunQueryResultDto[],
): { dataset: string; prompts: string[] }[] => {
    const groups: { dataset: string; prompts: string[] }[] = [];
    const indexOf = new Map<string, number>();
    for (const row of results) {
        let at = indexOf.get(row.dataset);
        if (at === undefined) {
            at = groups.length;
            indexOf.set(row.dataset, at);
            groups.push({ dataset: row.dataset, prompts: [] });
        }
        groups[at].prompts.push(row.prompt);
    }
    return groups;
};

const renderResultRow = (prompt: string, highlights: string[]): string =>
    `<tr><td class="quarry-runquery-result-prompt"><div class="quarry-runquery-prompt-text">${highlightPrompt(prompt, highlights)}</div></td><td class="quarry-runquery-result-copy"><button type="button" class="basic-button quarry-runquery-copy" title="Copy prompt">${COPY_GLYPH}</button></td></tr>`;

const renderDatasetGroup = (
    dataset: string,
    prompts: string[],
    highlights: string[],
): string => {
    const rows = prompts
        .map((prompt) => renderResultRow(prompt, highlights))
        .join("");
    return `<div class="quarry-runquery-dataset-group">
        <div class="quarry-runquery-dataset-heading">${escapeHtml(dataset)}</div>
        <table class="quarry-preview-table simple-table quarry-runquery-table">
            <colgroup><col class="quarry-runquery-col-prompt"><col class="quarry-runquery-col-copy"></colgroup>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
};

export const renderRunQueryResults = (
    results: RunQueryResultDto[],
    highlights: string[] = [],
): string => {
    if (!results || results.length === 0) {
        return `<div class="quarry-preview-empty">No matching rows.</div>`;
    }
    return groupResultsByDataset(results)
        .map((group) =>
            renderDatasetGroup(group.dataset, group.prompts, highlights),
        )
        .join("");
};

/** The summary rides in the controls row, the rest fills the scrolling body. */
export interface RunQueryView {
    summary: string;
    body: string;
}

export const renderRunQueryResponse = (
    data: RunQueryResponse,
): RunQueryView => {
    if (data.invalid) {
        return {
            summary: "",
            body: `<div class="quarry-runquery-invalid">${escapeHtml(data.invalid)}</div>`,
        };
    }
    if (data.error) {
        return {
            summary: "",
            body: `<div class="quarry-preview-error">${escapeHtml(data.error)}</div>`,
        };
    }
    const datasets = data.datasets ?? [];
    const results = data.results ?? [];
    return {
        summary: renderRunQuerySummary(
            data.total ?? 0,
            datasets.length,
            results.length,
            data.truncated ?? false,
            commonDatasetPrefix(datasets.map((dataset) => dataset.name)),
        ),
        body:
            renderRunQueryDatasetCounts(datasets) +
            renderRunQueryResults(results, data.highlights ?? []),
    };
};

let runBusy = false;

const updateRunControls = (): void => {
    const run = document.getElementById(RUN_ID) as HTMLButtonElement | null;
    if (run) {
        run.disabled = runBusy;
    }
};

const showView = (view: RunQueryView): void => {
    const summaryEl = document.getElementById(SUMMARY_ID);
    if (summaryEl) {
        summaryEl.innerHTML = view.summary;
    }
    const bodyEl = document.getElementById(RESULTS_ID);
    if (bodyEl) {
        bodyEl.innerHTML = view.body;
    }
};

const runQuery = (): void => {
    if (runBusy) {
        return;
    }
    const queryEl = document.getElementById(
        QUERY_ID,
    ) as HTMLTextAreaElement | null;
    const maxEl = document.getElementById(MAX_ID) as HTMLInputElement | null;
    if (!queryEl || !document.getElementById(RESULTS_ID)) {
        return;
    }
    const query = queryEl.value.trim();
    if (!query) {
        showView({
            summary: "",
            body: `<div class="quarry-runquery-invalid">Enter a &lt;q:&gt; query to run.</div>`,
        });
        return;
    }
    const maxResults = clampMaxResults(maxEl?.value);
    if (maxEl) {
        maxEl.value = String(maxResults);
    }
    runBusy = true;
    updateRunControls();
    showView({
        summary: "",
        body: `<div class="quarry-preview-loading">Running…</div>`,
    });
    genericRequest<RunQueryResponse>(
        "QuarryRunQuery",
        { query, maxResults },
        (data) => {
            runBusy = false;
            updateRunControls();
            showView(renderRunQueryResponse(data));
        },
    );
};

const handleResultsClick = (event: Event): void => {
    const button = (event.target as HTMLElement | null)?.closest(
        ".quarry-runquery-copy",
    );
    if (!button) {
        return;
    }
    const promptEl = button
        .closest("tr")
        ?.querySelector(".quarry-runquery-prompt-text");
    const prompt = promptEl?.textContent ?? "";
    if (typeof copyText === "function") {
        copyText(prompt);
    }
    if (typeof doNoticePopover === "function") {
        doNoticePopover("Copied!", "notice-pop-green");
    }
};

const ensureRunQueryModal = (): void => {
    if (document.getElementById(MODAL_ID)) {
        return;
    }
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.id = MODAL_ID;
    modal.tabIndex = -1;
    modal.setAttribute("role", "dialog");
    modal.innerHTML = `
        <div class="modal-dialog modal-lg quarry-runquery-dialog" role="document">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">Run Query</h5>
                </div>
                <div class="modal-body">
                    <div class="quarry-runquery-controls">
                        <label for="${QUERY_ID}" class="quarry-runquery-label">Query — paste a <code>&lt;q:&gt;</code> prompt tag (or just its inner part)</label>
                        <textarea id="${QUERY_ID}" class="auto-text quarry-runquery-input" rows="3" placeholder="${escapeHtml(EXAMPLE_QUERY)}" spellcheck="false"></textarea>
                        <div class="quarry-runquery-options">
                            <div id="${SUMMARY_ID}" class="quarry-runquery-summary-slot"></div>
                            <label for="${MAX_ID}" class="quarry-runquery-max-label">Max results</label>
                            <input type="number" id="${MAX_ID}" class="auto-text quarry-runquery-max" value="${RUNQUERY_DEFAULT_MAX}" min="${RUNQUERY_MIN_MAX}">
                            <button type="button" id="${RUN_ID}" class="basic-button quarry-runquery-run" title="Run the query and show the matching rows (Ctrl+Enter in the query box also runs)">Run</button>
                        </div>
                    </div>
                    <div id="${RESULTS_ID}" class="quarry-runquery-results"></div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary basic-button" data-bs-dismiss="modal">Close</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal
        .querySelector('[data-bs-dismiss="modal"]')
        ?.addEventListener("click", hideRunQueryModal);
    document
        .getElementById(RESULTS_ID)
        ?.addEventListener("click", handleResultsClick);
    document.getElementById(RUN_ID)?.addEventListener("click", runQuery);
    document.getElementById(QUERY_ID)?.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            runQuery();
        }
    });
    document.getElementById(MAX_ID)?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            runQuery();
        }
    });
};

const showRunQueryModal = (): void => {
    if (typeof $ === "function") {
        $(`#${MODAL_ID}`).modal("show");
    }
};

const hideRunQueryModal = (): void => {
    if (typeof $ === "function") {
        $(`#${MODAL_ID}`).modal("hide");
    }
};

export const openRunQueryModal = (): void => {
    ensureRunQueryModal();
    showRunQueryModal();
    document.getElementById(QUERY_ID)?.focus();
};
