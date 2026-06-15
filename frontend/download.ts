// The "Download Datasets" modal: browse the ready-made datasets on the official HuggingFace collection and
// pull them straight into the Quarry datasets folder. Lists each dataset with its size, marks the ones already
// installed (green highlight + ✓, with a "Redownload" button to refresh them), and shows a live progress bar
// while one downloads. The heavy lifting is on the backend (DatasetDownloader.cs); this module fetches the
// list, kicks off a download, and polls QuarryDownloadStatus for progress. One download runs at a time.

import type {
    AvailableDatasetsResponse,
    DownloadStatusResponse,
    RemoteDatasetDto,
    StartDownloadResponse,
} from "./types";
import { escapeHtml, formatBytes } from "./util";

const MODAL_ID = "quarry-download-modal";
const BODY_ID = "quarry-download-body";
const MESSAGE_ID = "quarry-download-message";
// How often to poll the backend for download progress, in ms. Generous: GB-scale downloads take minutes.
const POLL_MS = 800;

// --- Pure render helpers (exported for unit tests) ---

/// Renders one dataset row: name (with an installed ✓), size + file count, and a Download/Redownload button.
export const renderRemoteDatasetRow = (dataset: RemoteDatasetDto): string => {
    const name = escapeHtml(dataset.name);
    const installed = dataset.installed;
    const rowClass = installed
        ? "quarry-remote-row quarry-remote-installed"
        : "quarry-remote-row";
    const check = installed
        ? `<span class="quarry-remote-check" title="Installed">✓</span> `
        : "";
    const files = `${dataset.fileCount} file${dataset.fileCount === 1 ? "" : "s"}`;
    const label = installed ? "Redownload" : "Download";
    return `<tr class="${rowClass}" data-dataset="${name}">
        <td class="quarry-remote-name">${check}${name}</td>
        <td class="quarry-remote-size">${formatBytes(dataset.sizeBytes)} · ${files}</td>
        <td class="quarry-remote-action">
            <button type="button" class="basic-button quarry-remote-download" data-dataset="${name}" data-redownload="${installed}">${label}</button>
        </td>
    </tr>`;
};

/// Renders the full datasets table (or an empty hint).
export const renderRemoteDatasets = (list: RemoteDatasetDto[]): string => {
    if (!list || list.length === 0) {
        return `<div class="quarry-remote-empty">No datasets available right now.</div>`;
    }
    return `<table class="quarry-remote-table">
        <thead><tr><th>Dataset</th><th>Size</th><th>Action</th></tr></thead>
        <tbody>${list.map(renderRemoteDatasetRow).join("")}</tbody>
    </table>`;
};

/// Download completion as a clamped 0–100 integer (0 when the total isn't known yet).
export const progressPercent = (status: DownloadStatusResponse): number => {
    const total = status.bytesTotal ?? 0;
    const done = status.bytesDone ?? 0;
    if (total <= 0) {
        return 0;
    }
    return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
};

/// The one-line progress caption, e.g. `42% · 1.4 GB / 3.4 GB · 12.0 MB/s · file 3/21`.
export const renderProgressInfo = (status: DownloadStatusResponse): string => {
    if (status.state === "starting") {
        return "Starting…";
    }
    if (status.state === "finalizing") {
        return "Finalizing…";
    }
    const parts = [
        `${progressPercent(status)}%`,
        `${formatBytes(status.bytesDone ?? 0)} / ${formatBytes(status.bytesTotal ?? 0)}`,
    ];
    if ((status.perSecond ?? 0) > 0) {
        parts.push(`${formatBytes(status.perSecond)}/s`);
    }
    if ((status.filesTotal ?? 0) > 0) {
        parts.push(`file ${status.filesDone ?? 0}/${status.filesTotal}`);
    }
    return parts.join(" · ");
};

// --- Modal state ---

let onChanged: (() => void) | null = null;
let currentList: RemoteDatasetDto[] = [];
let tokenSet = false;
let repoUrl = "";
// The dataset whose download is currently being tracked (null when idle), and the run id we're polling.
let downloadingName: string | null = null;
let lastRunId = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

// --- Rendering into the modal ---

const renderNote = (): string => {
    const repo = repoUrl
        ? `<a href="${escapeHtml(repoUrl)}" target="_blank" rel="noreferrer noopener">the official collection</a>`
        : "the official collection";
    const tokenHint = tokenSet
        ? ""
        : ` <span class="quarry-download-tokenhint">No HuggingFace token set — this public collection still downloads fine; set a token under the User tab for authenticated downloads.</span>`;
    return `<div class="quarry-download-note">${currentList.length} dataset(s) from ${repo}.${tokenHint}</div>`;
};

/// (Re)renders the note + datasets table from the in-memory list. Used on load and whenever a download
/// finishes (restoring all the action buttons and reflecting the new installed state).
const renderList = (): void => {
    const body = document.getElementById(BODY_ID);
    if (body) {
        body.innerHTML = renderNote() + renderRemoteDatasets(currentList);
    }
};

const showMessage = (
    text: string,
    type: "success" | "error" | "info" = "info",
): void => {
    const el = document.getElementById(MESSAGE_ID);
    if (!el) {
        return;
    }
    el.textContent = text;
    el.className = text
        ? `quarry-download-message quarry-download-message-${type}`
        : "quarry-download-message";
};

/// The active row's action cell while a download runs: a progress bar, the caption, and a Cancel button.
const renderActionProgress = (status: DownloadStatusResponse): string =>
    `<div class="quarry-dl-progress"><div class="quarry-dl-bar" style="width: ${progressPercent(status)}%"></div></div>
     <div class="quarry-dl-info">${escapeHtml(renderProgressInfo(status))}</div>
     <button type="button" class="basic-button quarry-remote-cancel">Cancel</button>`;

const rowFor = (name: string): HTMLElement | null => {
    const body = document.getElementById(BODY_ID);
    if (!body) {
        return null;
    }
    for (const row of Array.from(
        body.querySelectorAll<HTMLElement>("tr.quarry-remote-row"),
    )) {
        if (row.getAttribute("data-dataset") === name) {
            return row;
        }
    }
    return null;
};

/// Puts the UI into "downloading" mode: disable every download button and swap the active row's action cell
/// for a fresh progress bar.
const markDownloadingUI = (name: string): void => {
    const body = document.getElementById(BODY_ID);
    if (!body) {
        return;
    }
    for (const button of Array.from(
        body.querySelectorAll<HTMLButtonElement>(".quarry-remote-download"),
    )) {
        button.disabled = true;
    }
    const row = rowFor(name);
    const action = row?.querySelector(".quarry-remote-action");
    if (row && action) {
        row.classList.add("quarry-remote-downloading");
        action.innerHTML = renderActionProgress({
            success: true,
            state: "starting",
        });
    }
};

const updateProgressUI = (
    name: string,
    status: DownloadStatusResponse,
): void => {
    const row = rowFor(name);
    if (!row) {
        return;
    }
    // Ensure the row is showing the progress widgets (e.g. when resuming an already-running download).
    if (!row.querySelector(".quarry-dl-bar")) {
        markDownloadingUI(name);
    }
    const bar = row.querySelector<HTMLElement>(".quarry-dl-bar");
    const info = row.querySelector<HTMLElement>(".quarry-dl-info");
    if (bar) {
        bar.style.width = `${progressPercent(status)}%`;
    }
    if (info) {
        info.textContent = renderProgressInfo(status);
    }
};

// --- Polling ---

const stopPolling = (): void => {
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
};

const scheduleNextPoll = (): void => {
    pollTimer = setTimeout(pollOnce, POLL_MS);
};

const finishDownload = (status: DownloadStatusResponse): void => {
    stopPolling();
    const name = downloadingName;
    downloadingName = null;
    lastRunId = 0;
    if (status.state === "done") {
        const entry = currentList.find((d) => d.name === name);
        if (entry) {
            entry.installed = true;
        }
        renderList();
        showMessage(`Downloaded ${name ?? "dataset"}.`, "success");
        onChanged?.();
    } else if (status.state === "error") {
        renderList();
        showMessage(
            `Download failed: ${status.error ?? "unknown error"}`,
            "error",
        );
    } else if (status.state === "cancelled") {
        renderList();
        showMessage("Download cancelled.", "info");
    } else {
        // Idle / nothing of ours running — just make sure the buttons are restored.
        renderList();
    }
};

const pollOnce = (): void => {
    pollTimer = null;
    genericRequest<DownloadStatusResponse>(
        "QuarryDownloadStatus",
        {},
        (status) => {
            if (!status.success) {
                scheduleNextPoll();
                return;
            }
            if (status.active) {
                if (status.dataset) {
                    updateProgressUI(status.dataset, status);
                }
                scheduleNextPoll();
                return;
            }
            // Not active: treat as the terminal state of the run we started (matched by id, so a stale
            // terminal left over from a different run is ignored).
            if (lastRunId === 0 || status.id === lastRunId) {
                finishDownload(status);
            } else {
                stopPolling();
            }
        },
    );
};

const startPolling = (): void => {
    if (!pollTimer) {
        pollOnce();
    }
};

/// On open, if a download is already running (this session resumed, or it was started elsewhere), reflect it.
const resumeIfActive = (): void => {
    genericRequest<DownloadStatusResponse>(
        "QuarryDownloadStatus",
        {},
        (status) => {
            if (status.success && status.active && status.dataset) {
                downloadingName = status.dataset;
                lastRunId = status.id ?? 0;
                markDownloadingUI(status.dataset);
                updateProgressUI(status.dataset, status);
                startPolling();
            }
        },
    );
};

// --- Actions ---

const startDownload = (name: string, redownload: boolean): void => {
    if (downloadingName) {
        return; // one at a time
    }
    showMessage("");
    genericRequest<StartDownloadResponse>(
        "QuarryDownloadDataset",
        { dataset: name, redownload },
        (data) => {
            if (!data.success) {
                showMessage(
                    data.error ?? "Could not start the download.",
                    "error",
                );
                return;
            }
            downloadingName = name;
            lastRunId = data.id ?? 0;
            markDownloadingUI(name);
            startPolling();
        },
    );
};

const cancelDownload = (): void => {
    showMessage("Cancelling…", "info");
    genericRequest<{ success: boolean }>("QuarryCancelDownload", {}, () => {});
};

const loadAvailable = (): void => {
    const body = document.getElementById(BODY_ID);
    if (body) {
        body.innerHTML = `<div class="quarry-download-loading">Loading…</div>`;
    }
    genericRequest<AvailableDatasetsResponse>(
        "QuarryListAvailableDatasets",
        {},
        (data) => {
            if (!data.success) {
                if (body) {
                    body.innerHTML = `<div class="quarry-download-error">${escapeHtml(data.error ?? "Failed to load the dataset list.")}</div>`;
                }
                return;
            }
            currentList = data.datasets ?? [];
            tokenSet = data.tokenSet ?? false;
            repoUrl = data.repoUrl ?? "";
            renderList();
            resumeIfActive();
        },
    );
};

const bodyClickHandler = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    const downloadButton = target?.closest<HTMLElement>(
        ".quarry-remote-download",
    );
    if (downloadButton) {
        const name = downloadButton.getAttribute("data-dataset");
        const redownload =
            downloadButton.getAttribute("data-redownload") === "true";
        if (name) {
            startDownload(name, redownload);
        }
        return;
    }
    if (target?.closest(".quarry-remote-cancel")) {
        cancelDownload();
    }
};

// --- Modal scaffolding (mirrors the preview modal in settings.ts) ---

const ensureDownloadModal = (): void => {
    if (document.getElementById(MODAL_ID)) {
        return;
    }
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.id = MODAL_ID;
    modal.tabIndex = -1;
    modal.setAttribute("role", "dialog");
    modal.innerHTML = `
        <div class="modal-dialog modal-lg quarry-download-dialog" role="document">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">⬇ Download Datasets</h5>
                </div>
                <div class="modal-body">
                    <div id="${BODY_ID}" class="quarry-download-body"></div>
                    <div id="${MESSAGE_ID}" class="quarry-download-message"></div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary basic-button" data-bs-dismiss="modal">Close</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal
        .querySelector('[data-bs-dismiss="modal"]')
        ?.addEventListener("click", hideDownloadModal);
    document
        .getElementById(BODY_ID)
        ?.addEventListener("click", bodyClickHandler);
};

const showDownloadModal = (): void => {
    if (typeof $ === "function") {
        $(`#${MODAL_ID}`).modal("show");
    }
};

const hideDownloadModal = (): void => {
    if (typeof $ === "function") {
        $(`#${MODAL_ID}`).modal("hide");
    }
};

/// Opens the Download Datasets modal and loads the available list. `onChangedCb` is invoked after each
/// successful download so the caller can refresh its own view (the settings table) to show the new dataset.
export const openDownloadModal = (onChangedCb: () => void): void => {
    onChanged = onChangedCb;
    ensureDownloadModal();
    showDownloadModal();
    loadAvailable();
};
