import datasetSources from "../dataset-sources.json";
import { bindRepairButton } from "./repair";
import type {
    AvailableDatasetsResponse,
    DownloadStatusResponse,
    RemoteDatasetDto,
    StartDownloadResponse,
} from "./types";
import {
    allAncestorsExpanded,
    buildFolderTree,
    datasetFolder,
    datasetLeafName,
    escapeHtml,
    type FolderNode,
    folderDatasetCount,
    formatBytes,
    refreshFolderVisibility,
} from "./util";

const MODAL_ID = "quarry-download-modal";
const BODY_ID = "quarry-download-body";
const MESSAGE_ID = "quarry-download-message";
const PROGRESS_ID = "quarry-download-progress";
const START_ID = "quarry-download-start";
const REFRESH_ID = "quarry-download-refresh";
const REPAIR_ID = "quarry-repair-datasets";
let repairing = false;
const POLL_MS = 800;

const hasUpdate = (dataset: RemoteDatasetDto): boolean =>
    dataset.installed && dataset.updateAvailable === true;

const folderUpdateCount = (node: FolderNode<RemoteDatasetDto>): number =>
    node.items.filter(hasUpdate).length +
    node.folders.reduce((count, child) => count + folderUpdateCount(child), 0);

const sourceOverrides = new Map<string, string | null>();
const sourceLeaves = new Map<
    string,
    { name: string; url: string | null } | null
>();
for (const source of datasetSources) {
    for (const name of [source.name, source.alias]) {
        if (name == null) {
            continue;
        }
        const url = source.sourceUrl || null;
        sourceOverrides.set(name.toLowerCase(), url);
        const leaf = datasetLeafName(name).toLowerCase();
        if (!sourceLeaves.has(leaf)) {
            sourceLeaves.set(leaf, { name: source.name, url });
        } else if (sourceLeaves.get(leaf)?.name !== source.name) {
            sourceLeaves.set(leaf, null);
        }
    }
}
for (const [leaf, source] of sourceLeaves) {
    if (source && !sourceOverrides.has(leaf)) {
        sourceOverrides.set(leaf, source.url);
    }
}

export const sourceRepoUrl = (name: string): string | null => {
    const key = name.toLowerCase();
    if (sourceOverrides.has(key)) {
        return sourceOverrides.get(key) ?? null;
    }
    // Category folders precede the org.repo segment; later dots name subsets.
    const source = name.split("/").find((segment) => segment.includes("."));
    if (!source) {
        return null;
    }
    const [org, repo] = source.split(".");
    if (!org || !repo) {
        return null;
    }
    return `https://huggingface.co/datasets/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
};

export const renderRemoteDatasetName = (
    name: string,
    displayName: string = name,
): string => {
    const label = escapeHtml(displayName);
    const url = sourceRepoUrl(name);
    if (!url) {
        return label;
    }
    return `<a class="quarry-remote-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener" title="Open source for ${escapeHtml(name)}">${label}</a>`;
};

export const renderRemoteDatasetRow = (
    dataset: RemoteDatasetDto,
    displayName: string = dataset.name,
    depth = 0,
    container: string | null = null,
    hidden = false,
): string => {
    const name = escapeHtml(dataset.name);
    const installed = dataset.installed;
    const updateAvailable = hasUpdate(dataset);
    const rowClass = installed
        ? "quarry-remote-row quarry-remote-installed"
        : "quarry-remote-row";
    const hiddenClass = hidden ? " quarry-row-hidden" : "";
    const parentAttr = container
        ? ` data-parent="${escapeHtml(container)}"`
        : "";
    const check = installed
        ? `<span class="quarry-remote-check" title="Installed">✓</span> `
        : "";
    const update = updateAvailable
        ? ' <span class="quarry-remote-update">Update available!</span>'
        : "";
    const title = updateAvailable
        ? "Update available! Select to update"
        : installed
          ? "Already installed — select to redownload"
          : "Select to download";
    return `<tr class="${rowClass}${hiddenClass}" data-dataset="${name}"${parentAttr} style="--quarry-depth: ${depth}">
        <td class="quarry-remote-selcell">
            <input type="checkbox" class="quarry-remote-select" data-dataset="${name}" data-installed="${installed}" data-update="${updateAvailable}" title="${title}" />
        </td>
        <td class="quarry-remote-name">${check}${renderRemoteDatasetName(dataset.name, displayName)}${update}</td>
        <td class="quarry-remote-size">${formatBytes(dataset.sizeBytes)}</td>
    </tr>`;
};

export const renderRemoteFolderHeaderRow = (
    node: FolderNode<RemoteDatasetDto>,
    depth: number,
    expanded: ReadonlySet<string>,
): string => {
    const path = escapeHtml(node.path);
    const collapsed = !expanded.has(node.path);
    const container = datasetFolder(node.path);
    const count = folderDatasetCount(node);
    const updates = folderUpdateCount(node);
    const hiddenClass = allAncestorsExpanded(container, expanded)
        ? ""
        : " quarry-row-hidden";
    const collapsedClass = collapsed ? " quarry-collapsed" : "";
    const parentAttr = container
        ? ` data-parent="${escapeHtml(container)}"`
        : "";
    return `<tr class="quarry-folder-row${collapsedClass}${hiddenClass}" data-folder="${path}"${parentAttr} style="--quarry-depth: ${depth}">
        <td colspan="3">
            <button type="button" class="quarry-folder-toggle" data-folder="${path}" aria-expanded="${!collapsed}" title="Show or hide the datasets in this folder">
                <span class="quarry-folder-caret" aria-hidden="true"></span>
                <span class="quarry-folder-name">${escapeHtml(node.name)}</span>
                <span class="quarry-folder-count" title="${count} dataset(s)">${count}</span>
                ${updates ? `<span class="quarry-remote-update">${updates} update${updates === 1 ? "" : "s"} available!</span>` : ""}
            </button>
        </td>
    </tr>`;
};

const renderRemoteFolderNode = (
    node: FolderNode<RemoteDatasetDto>,
    depth: number,
    expanded: ReadonlySet<string>,
): string => {
    const childrenHidden = !allAncestorsExpanded(node.path, expanded);
    const subFolders = node.folders
        .map((child) => renderRemoteFolderNode(child, depth + 1, expanded))
        .join("");
    const items = node.items
        .map((dataset) =>
            renderRemoteDatasetRow(
                dataset,
                datasetLeafName(dataset.name),
                depth + 1,
                node.path,
                childrenHidden,
            ),
        )
        .join("");
    return (
        renderRemoteFolderHeaderRow(node, depth, expanded) + subFolders + items
    );
};

export const renderRemoteDatasets = (
    list: RemoteDatasetDto[],
    expandedFolders: ReadonlySet<string> = new Set<string>(),
): string => {
    if (!list || list.length === 0) {
        return `<div class="quarry-remote-empty">No datasets available right now.</div>`;
    }
    const { loose, folders } = buildFolderTree(list);
    const folderRows = folders
        .map((folder) => renderRemoteFolderNode(folder, 0, expandedFolders))
        .join("");
    const looseRows = loose
        .map((dataset) => renderRemoteDatasetRow(dataset))
        .join("");
    return `<table class="quarry-remote-table">
        <thead><tr>
            <th class="quarry-remote-selcell"><input type="checkbox" class="quarry-remote-selectall" title="Select all" /></th>
            <th>Dataset</th>
            <th>Size</th>
        </tr></thead>
        <tbody>${folderRows}${looseRows}</tbody>
    </table>`;
};

export const progressPercent = (status: DownloadStatusResponse): number => {
    const total = status.bytesTotal ?? 0;
    const done = status.bytesDone ?? 0;
    if (total <= 0) {
        return 0;
    }
    return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
};

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

interface QueueItem {
    name: string;
    redownload: boolean;
}

let onChanged: (() => void) | null = null;
let currentList: RemoteDatasetDto[] = [];
let tokenSet = false;
let repoUrl = "";
const expandedFolders = new Set<string>();
let queue: QueueItem[] = [];
let queueIndex = 0;
let queueTotal = 0;
let completedCount = 0;
let failedNames: string[] = [];
let cancelledBatch = false;
let downloadingName: string | null = null;
let lastRunId = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

const renderNote = (): string => {
    const repo = repoUrl
        ? `<a href="${escapeHtml(repoUrl)}" target="_blank" rel="noreferrer noopener">the official collection</a>`
        : "the official collection";
    const tokenHint = tokenSet
        ? ""
        : ` <span class="quarry-download-tokenhint">No HuggingFace token set — this public collection still downloads fine; set a token under the User tab for authenticated downloads.</span>`;
    const updates = currentList.filter(hasUpdate).length;
    const updateNotice = updates
        ? `<div class="quarry-download-updates"><span class="quarry-remote-update">${updates} update${updates === 1 ? "" : "s"} available!</span> <button type="button" class="basic-button quarry-select-updates">Select updates</button></div>`
        : "";
    return `<div class="quarry-download-note">${currentList.length} dataset(s) from ${repo}. Select datasets to download or update.${tokenHint}</div>${updateNotice}`;
};

const renderList = (): void => {
    const body = document.getElementById(BODY_ID);
    if (body) {
        body.innerHTML =
            renderNote() + renderRemoteDatasets(currentList, expandedFolders);
    }
    updateSelectAllState();
    updateStartButtonState();
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

const rowCheckboxes = (): HTMLInputElement[] => {
    const body = document.getElementById(BODY_ID);
    return body
        ? Array.from(
              body.querySelectorAll<HTMLInputElement>(".quarry-remote-select"),
          )
        : [];
};

const selectAllCheckbox = (): HTMLInputElement | null =>
    document
        .getElementById(BODY_ID)
        ?.querySelector<HTMLInputElement>(".quarry-remote-selectall") ?? null;

const selectedDatasets = (): QueueItem[] =>
    rowCheckboxes()
        .filter((cb) => cb.checked)
        .map((cb) => ({
            name: cb.getAttribute("data-dataset") ?? "",
            redownload: cb.getAttribute("data-installed") === "true",
        }))
        .filter((item) => item.name !== "");

const updateStartButtonState = (): void => {
    const start = document.getElementById(START_ID) as HTMLButtonElement | null;
    if (start) {
        const selected = rowCheckboxes().filter((cb) => cb.checked);
        start.disabled =
            repairing || downloadingName !== null || selected.length === 0;
        start.textContent =
            selected.length > 0 &&
            selected.every((cb) => cb.dataset.update === "true")
                ? "Update selected"
                : "Download selected";
    }
};

const updateSelectAllState = (): void => {
    const all = selectAllCheckbox();
    if (!all) {
        return;
    }
    const boxes = rowCheckboxes();
    const checked = boxes.filter((cb) => cb.checked).length;
    all.checked = boxes.length > 0 && checked === boxes.length;
    all.indeterminate = checked > 0 && checked < boxes.length;
};

const setControlsDownloading = (downloading: boolean): void => {
    downloading = downloading || repairing;
    const repair = document.getElementById(
        REPAIR_ID,
    ) as HTMLButtonElement | null;
    if (repair) {
        repair.disabled = downloading;
    }
    const body = document.getElementById(BODY_ID);
    if (body) {
        for (const cb of Array.from(
            body.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
                ".quarry-remote-select, .quarry-remote-selectall, .quarry-select-updates",
            ),
        )) {
            cb.disabled = downloading;
        }
    }
    const refresh = document.getElementById(
        REFRESH_ID,
    ) as HTMLButtonElement | null;
    if (refresh) {
        refresh.disabled = downloading;
    }
    if (downloading) {
        const start = document.getElementById(
            START_ID,
        ) as HTMLButtonElement | null;
        if (start) {
            start.disabled = true;
        }
    } else {
        updateStartButtonState();
    }
};

const highlightActiveRow = (name: string | null): void => {
    const body = document.getElementById(BODY_ID);
    if (!body) {
        return;
    }
    for (const row of Array.from(
        body.querySelectorAll<HTMLElement>("tr.quarry-remote-row"),
    )) {
        row.classList.toggle(
            "quarry-remote-downloading",
            name !== null && row.getAttribute("data-dataset") === name,
        );
    }
};

const progressLabel = (): string => {
    const name = escapeHtml(downloadingName ?? "");
    const counter =
        queueTotal > 1 ? `${queueIndex + 1} of ${queueTotal} · ` : "";
    return `Downloading ${counter}${name}`;
};

const showBatchProgress = (status: DownloadStatusResponse): void => {
    const panel = document.getElementById(PROGRESS_ID);
    if (!panel) {
        return;
    }
    panel.style.display = "block";
    panel.innerHTML = `<div class="quarry-dl-label">${progressLabel()}</div>
        <div class="quarry-dl-progress"><div class="quarry-dl-bar" style="width: ${progressPercent(status)}%"></div></div>
        <div class="quarry-dl-info">${escapeHtml(renderProgressInfo(status))}</div>
        <button type="button" class="basic-button quarry-remote-cancel">Cancel</button>`;
};

const updateBatchProgress = (status: DownloadStatusResponse): void => {
    const panel = document.getElementById(PROGRESS_ID);
    if (!panel) {
        return;
    }
    if (!panel.querySelector(".quarry-dl-bar")) {
        showBatchProgress(status);
        return;
    }
    const bar = panel.querySelector<HTMLElement>(".quarry-dl-bar");
    const info = panel.querySelector<HTMLElement>(".quarry-dl-info");
    const label = panel.querySelector<HTMLElement>(".quarry-dl-label");
    if (bar) {
        bar.style.width = `${progressPercent(status)}%`;
    }
    if (info) {
        info.textContent = renderProgressInfo(status);
    }
    if (label) {
        label.textContent = progressLabel();
    }
};

const hideBatchProgress = (): void => {
    const panel = document.getElementById(PROGRESS_ID);
    if (panel) {
        panel.style.display = "none";
        panel.innerHTML = "";
    }
};

const stopPolling = (): void => {
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
};

const scheduleNextPoll = (): void => {
    pollTimer = setTimeout(pollOnce, POLL_MS);
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
                updateBatchProgress(status);
                scheduleNextPoll();
                return;
            }
            if (lastRunId === 0 || status.id === lastRunId) {
                onItemFinished(status);
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

const onItemFinished = (status: DownloadStatusResponse): void => {
    stopPolling();
    const name = downloadingName;
    downloadingName = null;
    lastRunId = 0;
    if (status.state === "done") {
        const entry = currentList.find((d) => d.name === name);
        if (entry) {
            entry.installed = true;
            entry.updateAvailable = false;
        }
        renderList();
        setControlsDownloading(true);
        completedCount++;
    } else if (status.state === "error") {
        failedNames.push(
            `${name ?? "dataset"} (${status.error ?? "unknown error"})`,
        );
    } else if (status.state === "cancelled") {
        cancelledBatch = true;
    }
    queueIndex++;
    startNext();
};

const startNext = (): void => {
    if (cancelledBatch || queueIndex >= queue.length) {
        finishBatch();
        return;
    }
    const item = queue[queueIndex];
    highlightActiveRow(item.name);
    showBatchProgress({ success: true, state: "starting" });
    genericRequest<StartDownloadResponse>(
        "QuarryDownloadDataset",
        { dataset: item.name, redownload: item.redownload },
        (data) => {
            if (!data.success) {
                failedNames.push(
                    `${item.name} (${data.error ?? "could not start"})`,
                );
                queueIndex++;
                startNext();
                return;
            }
            downloadingName = item.name;
            lastRunId = data.id ?? 0;
            startPolling();
        },
    );
};

const finishBatch = (): void => {
    stopPolling();
    downloadingName = null;
    lastRunId = 0;
    hideBatchProgress();
    highlightActiveRow(null);
    renderList();
    setControlsDownloading(false);
    if (cancelledBatch) {
        showMessage(
            `Cancelled. Downloaded ${completedCount} of ${queueTotal}.`,
            "info",
        );
    } else if (failedNames.length > 0) {
        showMessage(
            `Downloaded ${completedCount} of ${queueTotal}. Failed: ${failedNames.join(", ")}.`,
            "error",
        );
    } else {
        showMessage(
            `Downloaded ${completedCount} dataset${completedCount === 1 ? "" : "s"}.`,
            "success",
        );
    }
    if (completedCount > 0) {
        onChanged?.();
    }
};

const startBatch = (): void => {
    if (downloadingName) {
        return; // a batch is already running
    }
    const selected = selectedDatasets();
    if (selected.length === 0) {
        return;
    }
    queue = selected;
    queueTotal = selected.length;
    queueIndex = 0;
    completedCount = 0;
    failedNames = [];
    cancelledBatch = false;
    showMessage("");
    setControlsDownloading(true);
    startNext();
};

const cancelDownload = (): void => {
    showMessage("Cancelling…", "info");
    cancelledBatch = true;
    genericRequest<{ success: boolean }>("QuarryCancelDownload", {}, () => {});
};

const resumeIfActive = (): void => {
    genericRequest<DownloadStatusResponse>(
        "QuarryDownloadStatus",
        {},
        (status) => {
            if (status.success && status.active && status.dataset) {
                queue = [{ name: status.dataset, redownload: false }];
                queueTotal = 1;
                queueIndex = 0;
                completedCount = 0;
                failedNames = [];
                cancelledBatch = false;
                downloadingName = status.dataset;
                lastRunId = status.id ?? 0;
                setControlsDownloading(true);
                highlightActiveRow(status.dataset);
                showBatchProgress(status);
                startPolling();
            }
        },
    );
};

const loadAvailable = (force = false): void => {
    const body = document.getElementById(BODY_ID);
    if (body) {
        body.innerHTML = `<div class="quarry-download-loading">Loading…</div>`;
    }
    genericRequest<AvailableDatasetsResponse>(
        "QuarryListAvailableDatasets",
        { refresh: force },
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
            if (downloadingName) {
                setControlsDownloading(true);
                highlightActiveRow(downloadingName);
            } else {
                resumeIfActive();
            }
        },
    );
};

const bodyChangeHandler = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (target?.classList.contains("quarry-remote-selectall")) {
        const checked = (target as HTMLInputElement).checked;
        for (const cb of rowCheckboxes()) {
            cb.checked = checked;
        }
    }
    if (
        target?.classList.contains("quarry-remote-select") ||
        target?.classList.contains("quarry-remote-selectall")
    ) {
        updateSelectAllState();
        updateStartButtonState();
    }
};

const progressClickHandler = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (target?.closest(".quarry-remote-cancel")) {
        cancelDownload();
    }
};

const toggleFolder = (toggle: HTMLElement): void => {
    const folder = toggle.getAttribute("data-folder");
    const row = toggle.closest<HTMLElement>(".quarry-folder-row");
    if (!folder || !row) {
        return;
    }
    const collapsed = row.classList.toggle("quarry-collapsed");
    toggle.setAttribute("aria-expanded", String(!collapsed));
    if (collapsed) {
        expandedFolders.delete(folder);
    } else {
        expandedFolders.add(folder);
    }
    const body = document.getElementById(BODY_ID);
    if (body) {
        refreshFolderVisibility(body, expandedFolders);
    }
};

const bodyClickHandler = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    const selectUpdates = target?.closest<HTMLButtonElement>(
        ".quarry-select-updates",
    );
    if (selectUpdates && !selectUpdates.disabled) {
        for (const cb of rowCheckboxes()) {
            cb.checked = cb.dataset.update === "true";
        }
        updateSelectAllState();
        updateStartButtonState();
    }
    const folderToggle = target?.closest<HTMLElement>(".quarry-folder-toggle");
    if (folderToggle) {
        toggleFolder(folderToggle);
    }
};

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
                    <h5 class="modal-title">Download Datasets</h5>
                </div>
                <div class="modal-body">
                    <div id="${BODY_ID}" class="quarry-download-body"></div>
                    <div id="${PROGRESS_ID}" class="quarry-download-progress" style="display: none;"></div>
                    <div id="${MESSAGE_ID}" class="quarry-download-message"></div>
                    <div id="quarry-repair-status" class="quarry-repair-status" role="status" aria-live="polite"></div>
                </div>
                <div class="modal-footer quarry-download-footer">
                    <div class="quarry-download-footer-actions">
                        <button type="button" id="${START_ID}" class="btn btn-primary basic-button" disabled>Download</button>
                        <button type="button" id="${REFRESH_ID}" class="btn btn-secondary basic-button">Refresh</button>
                        <button type="button" id="${REPAIR_ID}" class="btn btn-secondary basic-button" title="Fix casing errors caused by stale downloaded versions using existing local files. No dataset download is needed; previous metadata is backed up.">Repair datasets</button>
                    </div>
                    <button type="button" class="btn btn-secondary basic-button" data-bs-dismiss="modal">Close</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal
        .querySelector('[data-bs-dismiss="modal"]')
        ?.addEventListener("click", hideDownloadModal);
    document.getElementById(START_ID)?.addEventListener("click", startBatch);
    document
        .getElementById(REFRESH_ID)
        ?.addEventListener("click", () => loadAvailable(true));
    bindRepairButton(
        () => onChanged?.(),
        (busy) => {
            repairing = busy;
            setControlsDownloading(downloadingName !== null);
        },
    );
    document
        .getElementById(BODY_ID)
        ?.addEventListener("change", bodyChangeHandler);
    document
        .getElementById(BODY_ID)
        ?.addEventListener("click", bodyClickHandler);
    document
        .getElementById(PROGRESS_ID)
        ?.addEventListener("click", progressClickHandler);
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

export const openDownloadModal = (onChangedCb: () => void): void => {
    onChanged = onChangedCb;
    ensureDownloadModal();
    showDownloadModal();
    loadAvailable();
};
