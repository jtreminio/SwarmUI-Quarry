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

export const runQuerySummaryText = (
    total: number,
    datasetCount: number,
    shown: number,
    truncated: boolean,
): string => {
    const matches = `${total.toLocaleString()} match${total === 1 ? "" : "es"}`;
    const datasets = `${datasetCount.toLocaleString()} dataset${datasetCount === 1 ? "" : "s"}`;
    const note = truncated
        ? ` · showing the first ${shown.toLocaleString()}`
        : "";
    return `${matches} across ${datasets}${note}`;
};

export const renderRunQueryDatasetCounts = (
    datasets: RunQueryDatasetDto[],
): string => {
    if (!datasets || datasets.length === 0) {
        return "";
    }
    const items = datasets
        .map(
            (dataset) =>
                `<li><span class="quarry-runquery-dataset-name">${escapeHtml(dataset.name)}</span><span class="quarry-runquery-dataset-count">${dataset.matches.toLocaleString()}</span></li>`,
        )
        .join("");
    return `<ul class="quarry-runquery-datasets">${items}</ul>`;
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

export const renderRunQueryResponse = (data: RunQueryResponse): string => {
    if (data.invalid) {
        return `<div class="quarry-runquery-invalid">${escapeHtml(data.invalid)}</div>`;
    }
    if (data.error) {
        return `<div class="quarry-preview-error">${escapeHtml(data.error)}</div>`;
    }
    const datasets = data.datasets ?? [];
    const results = data.results ?? [];
    const summary = `<div class="quarry-runquery-summary">${escapeHtml(
        runQuerySummaryText(
            data.total ?? 0,
            datasets.length,
            results.length,
            data.truncated ?? false,
        ),
    )}</div>`;
    return (
        summary +
        renderRunQueryDatasetCounts(datasets) +
        renderRunQueryResults(results, data.highlights ?? [])
    );
};

let runBusy = false;

const updateRunControls = (): void => {
    const run = document.getElementById(RUN_ID) as HTMLButtonElement | null;
    if (run) {
        run.disabled = runBusy;
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
    const resultsEl = document.getElementById(RESULTS_ID);
    if (!queryEl || !resultsEl) {
        return;
    }
    const query = queryEl.value.trim();
    if (!query) {
        resultsEl.innerHTML = `<div class="quarry-runquery-invalid">Enter a &lt;q:&gt; query to run.</div>`;
        return;
    }
    const maxResults = clampMaxResults(maxEl?.value);
    if (maxEl) {
        maxEl.value = String(maxResults);
    }
    runBusy = true;
    updateRunControls();
    resultsEl.innerHTML = `<div class="quarry-preview-loading">Running…</div>`;
    genericRequest<RunQueryResponse>(
        "QuarryRunQuery",
        { query, maxResults },
        (data) => {
            runBusy = false;
            updateRunControls();
            const bodyEl = document.getElementById(RESULTS_ID);
            if (bodyEl) {
                bodyEl.innerHTML = renderRunQueryResponse(data);
            }
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
                            <label for="${MAX_ID}">Max results</label>
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
