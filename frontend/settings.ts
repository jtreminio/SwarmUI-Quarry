import { setCompletionDatasets } from "./complete";
import { openDownloadModal } from "./download";
import { DatasetExplorer } from "./explore";
import {
    initFolderPickers,
    renderFolderPicker,
    selectedFolderValues,
    syncPicker,
} from "./folderPicker";
import {
    insertQuarryTag,
    onReferences,
    recomputeReferences,
    setAddToExistingTag,
} from "./prompt";
import { openRunQueryModal } from "./runquery";
import { QUARRY_TAB_BODY_ID } from "./tab";
import type {
    CleanTempResponse,
    DatasetDto,
    InstallResponse,
    PreviewResponse,
    SettingsResponse,
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

export { datasetFolder, datasetLeafName };

const MESSAGE_TIMEOUT_MS = 5000;
export const PREVIEW_ROW_LIMIT = 100;
const ADD_TO_EXISTING_TAG_ID = "quarry-add-to-existing-tag";
const PREVIEW_MODAL_ID = "quarry-preview-modal";
const PREVIEW_TITLE_ID = "quarry-preview-title";
const PREVIEW_BODY_ID = "quarry-preview-body";
const PREVIEW_STATUS_ID = "quarry-preview-status";
const PREVIEW_REFRESH_ID = "quarry-preview-refresh";

const expandedFolders = new Set<string>();

export const renderTagCheckboxes = (dataset: DatasetDto): string =>
    dataset.columns
        .map((col) => {
            const checked = (dataset.configuredTagColumns ?? []).includes(
                col.name,
            )
                ? " checked"
                : "";
            const badge = col.kind === "scalar" ? "" : ` [${col.kind}]`;
            return `<label class="quarry-tag-option"><input type="checkbox" class="quarry-dataset-tag" data-dataset="${escapeHtml(dataset.name)}" value="${escapeHtml(col.name)}"${checked}> ${escapeHtml(col.name)}${badge}</label>`;
        })
        .join("");

export const formatRowCount = (count: number | null | undefined): string =>
    count == null ? "—" : count.toLocaleString();

const SUMMARY_ID = "quarry-datasets-summary";

export const formatDatasetsSummary = (datasets: DatasetDto[]): string => {
    const total = datasets.length;
    let rows = 0;
    let counted = 0;
    let size = 0;
    for (const dataset of datasets) {
        if (dataset.rowCount != null) {
            rows += dataset.rowCount;
            counted += 1;
        }
        if (dataset.sizeBytes != null) {
            size += dataset.sizeBytes;
        }
    }
    const uncounted = total - counted;
    const datasetsLabel = `${total.toLocaleString()} dataset${total === 1 ? "" : "s"}`;
    const rowsLabel =
        uncounted > 0
            ? `${rows.toLocaleString()}+ rows (${uncounted.toLocaleString()} not counted yet)`
            : `${rows.toLocaleString()} rows`;
    return `${datasetsLabel} · ${rowsLabel} · ${formatBytes(size)}`;
};

export const applyInPromptHighlights = (
    container: HTMLElement,
    names: string[],
): void => {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    container
        .querySelectorAll<HTMLElement>("tr.quarry-dataset-row")
        .forEach((row) => {
            const name = (row.getAttribute("data-dataset") ?? "").toLowerCase();
            row.classList.toggle("quarry-dataset-in-prompt", wanted.has(name));
        });
};

export const renderDatasetNameButton = (
    name: string,
    label: string = name,
): string =>
    `<button type="button" class="quarry-dataset-name quarry-dataset-name-link" data-dataset="${name}" title="Add a reference to this dataset to your prompt">${label}</button>`;

const ENABLE_TITLE =
    "Enabled — included when a <q:> wildcard (like **) matches it. Click to disable.";
const DISABLE_TITLE =
    "Disabled — skipped by <q:> wildcards, but still used when a prompt names it explicitly. Click to enable.";

export const isDatasetEnabled = (dataset: DatasetDto): boolean =>
    dataset.enabled !== false;

export const renderEnableToggle = (name: string, enabled: boolean): string => {
    const stateCls = enabled ? "quarry-enabled" : "quarry-disabled";
    const title = enabled ? ENABLE_TITLE : DISABLE_TITLE;
    return `<button type="button" class="quarry-dataset-enable ${stateCls}" role="switch" aria-checked="${enabled}" data-dataset="${escapeHtml(name)}" title="${escapeHtml(title)}"><span class="quarry-enable-knob" aria-hidden="true"></span></button>`;
};

export const renderDatasetRow = (
    dataset: DatasetDto,
    displayName: string = dataset.name,
    depth = 0,
    container: string | null = null,
    hidden = false,
): string => {
    const name = escapeHtml(dataset.name);
    const label = escapeHtml(displayName);
    const enabled = isDatasetEnabled(dataset);
    const cls = `quarry-dataset-row${hidden ? " quarry-row-hidden" : ""}${enabled ? "" : " quarry-dataset-disabled"}`;
    const toggleCell = `<td class="quarry-dataset-enable-cell">${renderEnableToggle(dataset.name, enabled)}</td>`;
    const parentAttr = container
        ? ` data-parent="${escapeHtml(container)}"`
        : "";
    const attrs = `${parentAttr} style="--quarry-depth: ${depth}"`;
    if (dataset.error) {
        return `<tr class="${cls} quarry-dataset-error" data-dataset="${name}"${attrs}>
            ${toggleCell}
            <td class="quarry-dataset-name-cell">${renderDatasetNameButton(name, label)}</td>
            <td colspan="3"><span class="quarry-dataset-error-msg">⚠️ ${escapeHtml(dataset.error)}</span></td>
        </tr>`;
    }
    return `<tr class="${cls}" data-dataset="${name}"${attrs}>
        ${toggleCell}
        <td class="quarry-dataset-name-cell">${renderDatasetNameButton(name, label)}</td>
        <td class="quarry-dataset-columns">${dataset.columns.map((column) => `<span>${escapeHtml(column.name)}</span>`).join(", ") || "—"}</td>
        <td class="quarry-dataset-rows" data-dataset="${name}" title="Rows in the dataset (loads when you preview it if not already counted)">${formatRowCount(dataset.rowCount)}</td>
        <td class="quarry-dataset-action"><button type="button" class="basic-button quarry-preview-button" data-dataset="${name}" title="Explore columns, discover values, and test filters">Explore</button></td>
    </tr>`;
};

export const renderFolderHeaderRow = (
    node: FolderNode<DatasetDto>,
    depth: number,
    expanded: ReadonlySet<string>,
): string => {
    const path = escapeHtml(node.path);
    const collapsed = !expanded.has(node.path);
    const container = datasetFolder(node.path);
    const count = folderDatasetCount(node);
    const hiddenClass = allAncestorsExpanded(container, expanded)
        ? ""
        : " quarry-row-hidden";
    const collapsedClass = collapsed ? " quarry-collapsed" : "";
    const parentAttr = container
        ? ` data-parent="${escapeHtml(container)}"`
        : "";
    return `<tr class="quarry-folder-row${collapsedClass}${hiddenClass}" data-folder="${path}"${parentAttr} style="--quarry-depth: ${depth}">
        <td colspan="5">
            <button type="button" class="quarry-folder-toggle" data-folder="${path}" aria-expanded="${!collapsed}" title="Show or hide the datasets in this folder">
                <span class="quarry-folder-caret" aria-hidden="true"></span>
                <span class="quarry-folder-name">${escapeHtml(node.name)}</span>
                <span class="quarry-folder-count" title="${count} dataset(s)">${count}</span>
            </button>
        </td>
    </tr>`;
};

const renderFolderNode = (
    node: FolderNode<DatasetDto>,
    depth: number,
    expanded: ReadonlySet<string>,
): string => {
    const childrenHidden = !allAncestorsExpanded(node.path, expanded);
    const subFolders = node.folders
        .map((child) => renderFolderNode(child, depth + 1, expanded))
        .join("");
    const items = node.items
        .map((dataset) =>
            renderDatasetRow(
                dataset,
                datasetLeafName(dataset.name),
                depth + 1,
                node.path,
                childrenHidden,
            ),
        )
        .join("");
    return renderFolderHeaderRow(node, depth, expanded) + subFolders + items;
};

export const renderDatasets = (
    datasets: DatasetDto[],
    expandedFolders: ReadonlySet<string> = new Set<string>(),
): string => {
    if (!datasets || datasets.length === 0) {
        return `<div class="quarry-datasets-empty">No datasets found. Set a folder containing CSV / JSON / JSONL / Parquet / Lance files, then Refresh.</div>`;
    }
    const { loose, folders } = buildFolderTree(datasets);
    const folderRows = folders
        .map((folder) => renderFolderNode(folder, 0, expandedFolders))
        .join("");
    const looseRows = loose
        .map((dataset) => renderDatasetRow(dataset))
        .join("");
    return `<table class="quarry-datasets-table">
        <colgroup><col class="quarry-col-enabled"><col><col class="quarry-col-columns"><col class="quarry-col-rows"><col class="quarry-col-explore"></colgroup>
        <thead>
            <tr><th class="quarry-enable-th" title="Include this dataset when a wildcard matches. Direct dataset references work either way.">Wildcards</th><th>Dataset</th><th>Available columns</th><th class="quarry-rows-th">Rows</th><th>Explore</th></tr>
        </thead>
        <tbody>${folderRows}${looseRows}</tbody>
        <tfoot>
            <tr class="quarry-datasets-summary-row">
                <td colspan="5"><span id="${SUMMARY_ID}" class="quarry-datasets-summary" title="Totals across all datasets. Uncounted rows fill in as datasets are warmed or previewed.">${escapeHtml(formatDatasetsSummary(datasets))}</span></td>
            </tr>
        </tfoot>
    </table>`;
};

export const renderPreviewTable = (
    columns: string[],
    rows: string[][],
): string => {
    if (!columns || columns.length === 0) {
        return `<div class="quarry-preview-empty">No columns to display.</div>`;
    }
    const head = columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("");
    if (!rows || rows.length === 0) {
        return `<table class="quarry-preview-table simple-table">
            <thead><tr>${head}</tr></thead>
            <tbody><tr><td class="quarry-preview-empty" colspan="${columns.length}">No rows.</td></tr></tbody>
        </table>`;
    }
    const body = rows
        .map((row) => {
            const cells = columns
                .map((_, i) => `<td>${escapeHtml(row[i] ?? "")}</td>`)
                .join("");
            return `<tr>${cells}</tr>`;
        })
        .join("");
    return `<table class="quarry-preview-table simple-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
    </table>`;
};

export const renderPreviewStatus = (
    shown: number,
    total: number | null | undefined,
): string =>
    total == null
        ? `Showing ${shown.toLocaleString()} row(s).`
        : `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} row(s).`;

export const renderForm = (folder: string): string => `
    <div class="quarry-settings">
        <form id="quarry-form">
            <div class="input-group input-group-open">
                <span class="input-group-header input-group-noshrink">
                    <span class="header-label-wrap"><span class="header-label">🦆 Quarry</span></span>
                </span>
                <div class="input-group-content">
                    <div class="quarry-actions quarry-catalog-toolbar">
                        <button type="button" id="quarry-refresh" class="basic-button">Refresh</button>
                        <button type="button" id="quarry-download-datasets" class="basic-button" title="Browse and download ready-made datasets from the official collection">Download Datasets</button>
                        <button type="button" id="quarry-run-query" class="basic-button" title="Paste a &lt;q:&gt; prompt tag and see which datasets and rows it matches">Run Query</button>
                        <button type="button" id="quarry-settings-toggle" class="basic-button" aria-expanded="false" aria-controls="quarry-global-settings">Settings</button>
                    </div>
                    <section id="quarry-global-settings" class="quarry-global-settings" aria-label="Quarry settings" hidden>
                        <h3>Quarry settings</h3>
                        <label class="quarry-folder-setting" for="quarry-folder">Datasets folder
                            <input class="auto-text" type="text" id="quarry-folder" value="${escapeHtml(folder)}" placeholder="/path/to/datasets" autocomplete="off">
                        </label>
                        <label class="quarry-setting-row" for="${ADD_TO_EXISTING_TAG_ID}">
                            <input type="checkbox" id="${ADD_TO_EXISTING_TAG_ID}" checked>
                            Add dataset names to an existing <code>&lt;q:&gt;</code> tag
                        </label>
                        <p class="quarry-save-hint">When enabled, clicking a dataset name adds it to the first existing query tag in your prompt.</p>
                        <fieldset class="quarry-recurring-settings"><legend>Recurring values in Explore</legend>
                            <div class="quarry-explore-limits">
                                <label>Distinct values must be fewer than<input id="quarry-explore-unique-limit" class="auto-text" type="number" min="2" max="50000" step="1" value="10000" required></label>
                                <label>Every value must be shorter than (characters)<input id="quarry-explore-length-limit" class="auto-text" type="number" min="2" max="1000" step="1" value="256" required></label>
                                <label>Distinct values as a share of all rows (%)<input id="quarry-explore-distinct-percent" class="auto-text" type="number" min="0.1" max="100" step="0.1" value="10" required></label>
                            </div>
                            <p class="quarry-save-hint">Explore checks the entire column. All three limits must pass. Use 100% to allow any distinct-value share. Null and empty values are excluded from the distinct count; the percentage uses all rows. Saving changed limits triggers a new check.</p>
                        </fieldset>
                        <div class="quarry-actions quarry-global-settings-actions">
                            <button type="submit" class="basic-button">Save settings</button>
                            <button type="button" id="quarry-clean-temp" class="basic-button" title="Delete leftover placeholder .txt files an older Quarry version wrote into SwarmUI's Wildcards folder">Clean temp files</button>
                        </div>
                    </section>
                    <div id="quarry-message" class="quarry-message" role="status"></div>
                    <div id="quarry-datasets" class="quarry-datasets"></div>
                </div>
            </div>
        </form>
    </div>`;

export const renderInstallGate = (): string => `
    <div class="quarry-settings quarry-install-gate">
        <div class="input-group input-group-open">
            <span class="input-group-header input-group-noshrink">
                <span class="header-label-wrap"><span class="header-label">🦆 Quarry</span></span>
            </span>
            <div class="input-group-content">
                <p class="quarry-install-intro">Quarry needs the DuckDB <code>lance</code> extension to read its datasets — a one-time download of a ~235&nbsp;MB signed binary from the official DuckDB extension repository.</p>
                <div class="quarry-actions">
                    <button type="button" id="quarry-install" class="basic-button">⬇ Install Requirements</button>
                </div>
                <div id="quarry-install-status" class="quarry-install-status"></div>
            </div>
        </div>
    </div>`;

export const collectTagColumns = (
    container: HTMLElement,
): Record<string, string[]> => {
    const result: Record<string, string[]> = {};
    const boxes = container.querySelectorAll<HTMLInputElement>(
        "input.quarry-dataset-tag",
    );
    boxes.forEach((box) => {
        const name = box.getAttribute("data-dataset");
        if (!name) {
            return;
        }
        if (!(name in result)) {
            result[name] = [];
        }
        if (box.checked) {
            result[name].push(box.value);
        }
    });
    return result;
};

let messageTimer: ReturnType<typeof setTimeout> | null = null;

const applyTableHighlights = (names: string[]): void => {
    const container = document.getElementById("quarry-datasets");
    if (container) {
        applyInPromptHighlights(container, names);
    }
};

let currentDatasets: DatasetDto[] = [];
let savedSettings: SettingsResponse = { success: true };

export const datasetColumnSettings = (datasets: DatasetDto[]) => ({
    promptColumns: Object.fromEntries(
        datasets
            .filter((dataset) => dataset.configuredPromptColumn != null)
            .map((dataset) => [dataset.name, dataset.configuredPromptColumn]),
    ),
    tagColumns: Object.fromEntries(
        datasets.map((dataset) => [
            dataset.name,
            [...dataset.configuredTagColumns],
        ]),
    ),
});

const savedSettingsRequest = (): Record<string, unknown> => {
    const { promptColumns, tagColumns } =
        datasetColumnSettings(currentDatasets);
    return {
        datasetsFolder: savedSettings.datasetsFolder ?? "",
        promptColumnsJson: JSON.stringify(promptColumns),
        tagColumnsJson: JSON.stringify(tagColumns),
        disabledDatasetsJson: JSON.stringify(
            currentDatasets
                .filter((dataset) => dataset.enabled === false)
                .map((dataset) => dataset.name),
        ),
        addToExistingTag: savedSettings.addToExistingTag ?? true,
        exploreUniqueLimit: savedSettings.exploreUniqueLimit ?? 10000,
        exploreLengthLimit: savedSettings.exploreLengthLimit ?? 256,
        exploreDistinctPercent: savedSettings.exploreDistinctPercent ?? 10,
    };
};

const rememberSavedDatasetState = (data: SettingsResponse): void => {
    savedSettings = data;
    currentDatasets =
        data.datasets?.map((updated) => {
            const existing = currentDatasets.find(
                (item) => item.name === updated.name,
            );
            return existing ? Object.assign(existing, updated) : updated;
        }) ?? currentDatasets;
    setCompletionDatasets(currentDatasets);
};

const settingsRequests: (() => void)[] = [];
const requestSettings = <T = SettingsResponse>(
    endpoint: string,
    request: () => Record<string, unknown>,
    receive: (data: T) => void,
    fail: () => void,
): void => {
    const finish = (callback: () => void): void => {
        try {
            callback();
        } finally {
            settingsRequests.shift();
            settingsRequests[0]?.();
        }
    };
    settingsRequests.push(() => {
        genericRequest<T>(
            endpoint,
            request(),
            (data) => finish(() => receive(data)),
            0,
            () => finish(fail),
        );
    });
    if (settingsRequests.length === 1) settingsRequests[0]();
};

export const mountImageSearchFolders = (
    host: HTMLElement,
    onPermission: (allowed: boolean) => void = () => {},
): void => {
    initFolderPickers(document);
    host.innerHTML = '<p class="quarry-save-hint">Loading search folders…</p>';
    requestSettings(
        "QuarryGetSettings",
        () => ({}),
        (data) => {
            const allowed = data.success && data.canViewImageHistory === true;
            onPermission(allowed);
            if (!allowed) {
                host.hidden = true;
                host.replaceChildren();
                return;
            }
            rememberSavedDatasetState(data);
            host.innerHTML = `<section class="quarry-search-folder-setting" aria-label="Image search folders">
            <h3>Search folders</h3>
            <p class="quarry-search-folder-help">Choose which output folders are indexed. Each selected folder includes its descendants. All includes future folders.</p>
            <div data-image-search-folder-picker>${renderFolderPicker(data.imageSearchDirectories ?? [""], data.imageSearchDirectoryOptions ?? [])}</div>
            <div class="quarry-actions"><button type="button" class="basic-button" data-save-search-folders>Save folders</button><span class="quarry-save-hint" data-search-folders-status role="status"></span></div>
            <p class="quarry-search-folder-help">After saving, use Rescan history to update the search index.</p>
        </section>`;
            const picker = host.querySelector<HTMLElement>(
                "[data-image-search-folder-picker]",
            );
            const button = host.querySelector<HTMLButtonElement>(
                "[data-save-search-folders]",
            );
            const status = host.querySelector<HTMLElement>(
                "[data-search-folders-status]",
            );
            if (!picker || !button || !status) return;
            syncPicker(picker);
            button.addEventListener("click", () => {
                button.disabled = true;
                status.textContent = "Saving…";
                const fail = (message: string): void => {
                    button.disabled = false;
                    status.textContent = message;
                };
                const folders = selectedFolderValues(picker);
                requestSettings(
                    "QuarrySaveSettings",
                    () => ({
                        ...savedSettingsRequest(),
                        imageSearchDirectoriesJson: JSON.stringify(folders),
                    }),
                    (response) => {
                        if (!response.success) {
                            fail(
                                `Failed to save: ${response.error ?? "unknown error"}`,
                            );
                            return;
                        }
                        rememberSavedDatasetState(response);
                        button.disabled = false;
                        status.textContent =
                            "Folders saved. Rescan history to update the index.";
                    },
                    () => fail("Failed to save folders. Try again."),
                );
            });
        },
        () => {
            host.textContent = "Failed to load search folders. Try again.";
        },
    );
};

export const renderDatasetSettings = (dataset: DatasetDto): string => `
    <div class="quarry-persistent-settings">
        <h3>${escapeHtml(dataset.name)}</h3>
        <p class="quarry-explore-note">Saved defaults for this dataset. Columns selected in Query override these defaults for that query only.</p>
        <section class="quarry-dataset-settings-group"><h4>Default output</h4>
            <label>Column to print<select class="quarry-dataset-column auto-dropdown" data-dataset="${escapeHtml(dataset.name)}"><option value="" ${dataset.configuredPromptColumn == null ? "selected" : ""}>Automatic (${escapeHtml(dataset.resolvedPromptColumn ?? "first available column")})</option>${dataset.columns.map((column) => `<option value="${escapeHtml(column.name)}" ${column.name === dataset.configuredPromptColumn ? "selected" : ""}>${escapeHtml(column.name)}</option>`).join("")}</select></label>
        </section>
        <section class="quarry-dataset-settings-group" aria-label="Tag search"><h4>Tag search</h4>
            <p class="quarry-explore-note">Choose columns searched by <code>tags</code>. With none selected, searches use the default output column.</p>
            <div class="quarry-dataset-tag-options">${renderTagCheckboxes(dataset)}</div>
        </section>
        <div class="quarry-actions"><button type="button" class="basic-button quarry-modal-action" data-save-dataset-settings>Save dataset settings</button>
            <span class="quarry-explore-note" data-dataset-settings-status role="status"></span>
        </div>
    </div>`;

export const mountDatasetSettings = (
    host: HTMLElement,
    dataset: DatasetDto,
    onSaved: (updated: DatasetDto) => void,
): (() => void) => {
    host.innerHTML = renderDatasetSettings(dataset);
    let disposed = false;
    const button = host.querySelector<HTMLButtonElement>(
        "[data-save-dataset-settings]",
    );
    const status = host.querySelector<HTMLElement>(
        "[data-dataset-settings-status]",
    );
    const outputSelect = host.querySelector<HTMLSelectElement>(
        ".quarry-dataset-column",
    );
    if (!button || !status || !outputSelect) return () => {};
    const save = (): void => {
        const output = outputSelect.value;
        const tags = collectTagColumns(host)[dataset.name] ?? [];
        button.disabled = true;
        status.textContent = "Saving…";
        const fail = (message: string): void => {
            if (disposed) return;
            button.disabled = false;
            status.textContent = message;
        };
        requestSettings(
            "QuarrySaveSettings",
            () => {
                const { promptColumns, tagColumns } =
                    datasetColumnSettings(currentDatasets);
                if (output) promptColumns[dataset.name] = output;
                else delete promptColumns[dataset.name];
                tagColumns[dataset.name] = tags;
                return {
                    ...savedSettingsRequest(),
                    promptColumnsJson: JSON.stringify(promptColumns),
                    tagColumnsJson: JSON.stringify(tagColumns),
                };
            },
            (data) => {
                if (!data.success) {
                    fail(`Failed to save: ${data.error ?? "unknown error"}`);
                    return;
                }
                rememberSavedDatasetState(data);
                const table = document.getElementById("quarry-datasets");
                if (table)
                    table.innerHTML = renderDatasets(
                        currentDatasets,
                        expandedFolders,
                    );
                recomputeReferences();
                if (disposed) return;
                button.disabled = false;
                status.textContent = "Dataset settings saved.";
                const updated = currentDatasets.find(
                    (item) => item.name === dataset.name,
                );
                if (updated) onSaved(updated);
            },
            () => fail("Failed to save dataset settings. Try again."),
        );
    };
    button.addEventListener("click", save);
    return () => {
        disposed = true;
        button.removeEventListener("click", save);
    };
};

const updateDatasetsSummary = (): void => {
    const el = document.getElementById(SUMMARY_ID);
    if (el) {
        el.textContent = formatDatasetsSummary(currentDatasets);
    }
};

const applyResponse = (data: SettingsResponse): void => {
    rememberSavedDatasetState(data);
    for (const [id, value] of [
        ["quarry-explore-unique-limit", data.exploreUniqueLimit ?? 10000],
        ["quarry-explore-length-limit", data.exploreLengthLimit ?? 256],
        ["quarry-explore-distinct-percent", data.exploreDistinctPercent ?? 10],
    ] as const) {
        const input = document.getElementById(id) as HTMLInputElement | null;
        if (input) input.value = String(value);
    }
    const folderEl = document.getElementById(
        "quarry-folder",
    ) as HTMLInputElement | null;
    if (folderEl) folderEl.value = data.datasetsFolder ?? "";
    const addToExisting = data.addToExistingTag ?? true;
    const addToExistingEl = document.getElementById(
        ADD_TO_EXISTING_TAG_ID,
    ) as HTMLInputElement | null;
    if (addToExistingEl) {
        addToExistingEl.checked = addToExisting;
    }
    setAddToExistingTag(addToExisting);
    const datasetsEl = document.getElementById("quarry-datasets");
    if (datasetsEl) {
        datasetsEl.innerHTML = renderDatasets(
            data.datasets ?? [],
            expandedFolders,
        );
        recomputeReferences();
    }
};

const showMessage = (message: string, type: "success" | "error"): void => {
    const el = document.getElementById("quarry-message");
    if (!el) {
        return;
    }
    el.textContent = message;
    el.className = `quarry-message quarry-message-${type}`;
    if (messageTimer) {
        clearTimeout(messageTimer);
    }
    messageTimer = setTimeout(() => {
        el.textContent = "";
        el.className = "quarry-message";
        messageTimer = null;
    }, MESSAGE_TIMEOUT_MS);
};

const loadSettings = (): void => {
    requestSettings(
        "QuarryGetSettings",
        () => ({}),
        (data) => {
            if (!data.success) {
                return;
            }
            if (data.requirementsInstalled === false) {
                showInstallGate();
                return;
            }
            ensureFormRendered();
            applyResponse(data);
        },
        () => {
            if (document.getElementById("quarry-form")) {
                showMessage("Failed to load settings. Try again.", "error");
            } else {
                const host = document.getElementById(QUARRY_TAB_BODY_ID);
                if (host)
                    host.textContent =
                        "Failed to load settings. Reload the page to try again.";
            }
        },
    );
};

const saveSettings = (): void => {
    const folder = (
        document.getElementById("quarry-folder") as HTMLInputElement
    ).value.trim();
    const addToExistingEl = document.getElementById(
        ADD_TO_EXISTING_TAG_ID,
    ) as HTMLInputElement | null;
    const changes = {
        datasetsFolder: folder,
        addToExistingTag: addToExistingEl?.checked ?? true,
        exploreUniqueLimit: Number(
            (
                document.getElementById(
                    "quarry-explore-unique-limit",
                ) as HTMLInputElement
            ).value,
        ),
        exploreLengthLimit: Number(
            (
                document.getElementById(
                    "quarry-explore-length-limit",
                ) as HTMLInputElement
            ).value,
        ),
        exploreDistinctPercent: Number(
            (
                document.getElementById(
                    "quarry-explore-distinct-percent",
                ) as HTMLInputElement
            ).value,
        ),
    };
    requestSettings(
        "QuarrySaveSettings",
        () => ({ ...savedSettingsRequest(), ...changes }),
        (data) => {
            if (data.success) {
                applyResponse(data);
                showMessage("Settings saved.", "success");
            } else {
                showMessage(
                    `Failed to save: ${data.error ?? "unknown error"}`,
                    "error",
                );
            }
        },
        () => showMessage("Failed to save settings. Try again.", "error"),
    );
};

const refresh = (): void => {
    const button = document.getElementById(
        "quarry-refresh",
    ) as HTMLButtonElement | null;
    if (button) {
        button.disabled = true;
    }
    requestSettings(
        "QuarryRefresh",
        () => ({}),
        (data) => {
            if (button) {
                button.disabled = false;
            }
            if (data.success) {
                applyResponse(data);
                showMessage(data.message ?? "Refreshed.", "success");
            } else {
                showMessage(
                    `Refresh failed: ${data.error ?? "unknown error"}`,
                    "error",
                );
            }
        },
        () => {
            if (button) button.disabled = false;
            showMessage("Failed to refresh datasets. Try again.", "error");
        },
    );
};

const cleanTempFiles = (): void => {
    const button = document.getElementById(
        "quarry-clean-temp",
    ) as HTMLButtonElement | null;
    if (button) {
        button.disabled = true;
    }
    genericRequest<CleanTempResponse>("QuarryCleanTempFiles", {}, (data) => {
        if (button) {
            button.disabled = false;
        }
        if (!data.success) {
            showMessage(
                `Clean failed: ${data.error ?? "unknown error"}`,
                "error",
            );
            return;
        }
        const removed = data.removed ?? 0;
        showMessage(
            removed > 0
                ? `Removed ${removed.toLocaleString()} leftover placeholder file(s).`
                : "No leftover placeholder files found.",
            "success",
        );
    });
};

let previewDataset: string | null = null;
let previewShown = 0;
let previewTotal: number | null = null;
let previewBusy = false;
let previewRequest = 0;
let previewError = "";
let explorer: DatasetExplorer | null = null;

const ensurePreviewModal = (): void => {
    if (document.getElementById(PREVIEW_MODAL_ID)) {
        return;
    }
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.id = PREVIEW_MODAL_ID;
    modal.tabIndex = -1;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-labelledby", PREVIEW_TITLE_ID);
    modal.innerHTML = `
        <div class="modal-dialog modal-xl quarry-preview-dialog" role="document">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title" id="${PREVIEW_TITLE_ID}">Explore</h5>
                </div>
                <div class="modal-body">
                    <div id="${PREVIEW_BODY_ID}" class="quarry-preview-body"></div>
                </div>
                <div class="modal-footer quarry-preview-footer">
                    <span id="${PREVIEW_STATUS_ID}" class="quarry-preview-status"></span>
                    <span class="quarry-preview-footer-actions">
                        <button type="button" id="${PREVIEW_REFRESH_ID}" class="basic-button quarry-modal-action" hidden title="Replace the displayed rows with up to 100 fresh random rows">Refresh sample</button>
                        <button type="button" class="basic-button quarry-modal-action" data-bs-dismiss="modal">Close</button>
                    </span>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal
        .querySelector('[data-bs-dismiss="modal"]')
        ?.addEventListener("click", hidePreviewModal);
    document
        .getElementById(PREVIEW_REFRESH_ID)
        ?.addEventListener("click", newPreviewSample);
};

const showPreviewModal = (): void => {
    if (typeof $ === "function") {
        $(`#${PREVIEW_MODAL_ID}`).modal("show");
    }
};

const hidePreviewModal = (): void => {
    if (typeof $ === "function") {
        $(`#${PREVIEW_MODAL_ID}`).modal("hide");
    }
};

const applyRowCount = (dataset: string, count: number | null): void => {
    const selector = `td.quarry-dataset-rows[data-dataset="${dataset.replace(/(["\\])/g, "\\$1")}"]`;
    for (const cell of Array.from(
        document.querySelectorAll<HTMLElement>(selector),
    )) {
        cell.textContent = formatRowCount(count);
    }
    const entry = currentDatasets.find((d) => d.name === dataset);
    if (entry) {
        entry.rowCount = count;
        updateDatasetsSummary();
    }
};

const updatePreviewControls = (): void => {
    const refresh = document.getElementById(
        PREVIEW_REFRESH_ID,
    ) as HTMLButtonElement | null;
    const status = document.getElementById(PREVIEW_STATUS_ID);
    if (refresh) refresh.disabled = previewBusy || !previewDataset;
    if (status) {
        status.textContent = previewBusy
            ? "Loading…"
            : previewError || renderPreviewStatus(previewShown, previewTotal);
    }
};

const fetchPreview = (dataset: string): void => {
    const request = ++previewRequest;
    previewBusy = true;
    previewError = "";
    updatePreviewControls();
    genericRequest<PreviewResponse>(
        "QuarryPreviewDataset",
        { dataset, limit: PREVIEW_ROW_LIMIT },
        (data) => {
            if (request !== previewRequest) {
                return;
            }
            previewBusy = false;
            if (!data.success) {
                previewError =
                    data.error ?? "Failed to load rows. Try loading again.";
                updatePreviewControls();
                return;
            }
            const columns = data.columns ?? [];
            const rows = (data.rows ?? []).slice(0, PREVIEW_ROW_LIMIT);
            previewShown = rows.length;
            previewTotal = data.rowCount ?? null;
            applyRowCount(dataset, previewTotal);
            explorer?.setRows(columns, rows);
            updatePreviewControls();
        },
        0,
        () => {
            if (request !== previewRequest) return;
            previewBusy = false;
            previewError = "Failed to load rows. Try again.";
            updatePreviewControls();
        },
    );
};

export const openPreview = (dataset: string): void => {
    const entry = currentDatasets.find((item) => item.name === dataset);
    if (!entry) return;
    ensurePreviewModal();
    explorer?.dispose();
    previewRequest++;
    previewBusy = false;
    previewError = "";
    previewDataset = dataset;
    previewShown = 0;
    previewTotal = null;
    const titleEl = document.getElementById(PREVIEW_TITLE_ID);
    if (titleEl) {
        titleEl.textContent = `Explore — ${dataset}`;
    }
    const bodyEl = document.getElementById(PREVIEW_BODY_ID);
    if (bodyEl) {
        explorer = new DatasetExplorer(
            bodyEl,
            entry,
            renderPreviewTable,
            hidePreviewModal,
            newPreviewSample,
            (showRows) => {
                const refresh = document.getElementById(PREVIEW_REFRESH_ID);
                if (refresh) refresh.hidden = !showRows;
                const status = document.getElementById(PREVIEW_STATUS_ID);
                if (status) status.hidden = !showRows;
            },
            currentDatasets,
            (source, names) => {
                const title = document.getElementById(PREVIEW_TITLE_ID);
                if (title)
                    title.textContent =
                        names.length > 1
                            ? `Explore — ${names.length} datasets`
                            : `Explore — ${source.name}`;
                if (previewDataset !== source.name) {
                    previewDataset = source.name;
                    previewShown = 0;
                    previewTotal = null;
                    previewRequest++;
                    previewBusy = false;
                    if (
                        !document.querySelector<HTMLElement>(
                            ".quarry-explore-rows-view",
                        )?.hidden
                    )
                        fetchPreview(source.name);
                }
            },
            mountDatasetSettings,
        );
    }
    showPreviewModal();
    explorer?.testQuery();
};

const newPreviewSample = (): void => {
    if (previewDataset) {
        fetchPreview(previewDataset);
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
    const container = document.getElementById("quarry-datasets");
    if (container) {
        refreshFolderVisibility(container, expandedFolders);
    }
};

const applyEnabledState = (button: HTMLElement, enabled: boolean): void => {
    button.setAttribute("aria-checked", String(enabled));
    button.classList.toggle("quarry-enabled", enabled);
    button.classList.toggle("quarry-disabled", !enabled);
    button.setAttribute("title", enabled ? ENABLE_TITLE : DISABLE_TITLE);
    button
        .closest<HTMLElement>(".quarry-dataset-row")
        ?.classList.toggle("quarry-dataset-disabled", !enabled);
};

const toggleDatasetEnabled = (button: HTMLElement): void => {
    const name = button.getAttribute("data-dataset");
    if (!name) return;
    const next = button.getAttribute("aria-checked") === "false";
    const updateButton = (enabled: boolean, pending: boolean): void => {
        const live = Array.from(
            document.querySelectorAll<HTMLButtonElement>(
                ".quarry-dataset-enable",
            ),
        ).find((item) => item.getAttribute("data-dataset") === name);
        if (live) {
            applyEnabledState(live, enabled);
            live.disabled = pending;
        }
    };
    const fail = (message: string): void => {
        const dataset = currentDatasets.find((item) => item.name === name);
        updateButton(dataset?.enabled !== false, false);
        showMessage(message, "error");
    };
    updateButton(next, true);
    requestSettings<{ success: boolean; error?: string }>(
        "QuarrySetDatasetEnabled",
        () => {
            updateButton(next, true);
            return { dataset: name, enabled: next };
        },
        (data) => {
            if (data.success) {
                const dataset = currentDatasets.find(
                    (item) => item.name === name,
                );
                if (dataset) dataset.enabled = next;
                updateButton(next, false);
                recomputeReferences();
            } else {
                fail(
                    `Failed to ${next ? "enable" : "disable"} '${name}': ${data.error ?? "unknown error"}`,
                );
            }
        },
        () =>
            fail(
                `Failed to ${next ? "enable" : "disable"} '${name}'. Try again.`,
            ),
    );
};

const datasetsClickHandler = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    const folderToggle = target?.closest<HTMLElement>(".quarry-folder-toggle");
    if (folderToggle) {
        toggleFolder(folderToggle);
        return;
    }
    const enableToggle = target?.closest<HTMLElement>(".quarry-dataset-enable");
    if (enableToggle) {
        toggleDatasetEnabled(enableToggle);
        return;
    }
    const previewButton = target?.closest<HTMLElement>(
        ".quarry-preview-button",
    );
    if (previewButton) {
        const dataset = previewButton.getAttribute("data-dataset");
        if (dataset) {
            openPreview(dataset);
        }
        return;
    }
    const nameCell = target?.closest<HTMLElement>(".quarry-dataset-name-cell");
    if (nameCell) {
        const dataset = nameCell
            .querySelector<HTMLElement>(".quarry-dataset-name-link")
            ?.getAttribute("data-dataset");
        if (dataset) {
            insertQuarryTag(dataset);
        }
    }
};

const ensureFormRendered = (): void => {
    initFolderPickers(document);
    if (document.getElementById("quarry-form")) {
        return;
    }
    const host = document.getElementById(QUARRY_TAB_BODY_ID);
    if (!host) {
        return;
    }
    host.innerHTML = renderForm("");
    document
        .getElementById("quarry-form")
        ?.addEventListener("submit", (event) => {
            event.preventDefault();
            saveSettings();
        });
    document
        .getElementById("quarry-refresh")
        ?.addEventListener("click", refresh);
    document
        .getElementById("quarry-settings-toggle")
        ?.addEventListener("click", () => {
            const panel = document.getElementById("quarry-global-settings");
            const button = document.getElementById("quarry-settings-toggle");
            if (!panel || !button) return;
            panel.hidden = !panel.hidden;
            button.setAttribute("aria-expanded", String(!panel.hidden));
        });
    document
        .getElementById("quarry-clean-temp")
        ?.addEventListener("click", cleanTempFiles);
    document
        .getElementById("quarry-download-datasets")
        ?.addEventListener("click", () => openDownloadModal(loadSettings));
    document
        .getElementById("quarry-run-query")
        ?.addEventListener("click", openRunQueryModal);
    document
        .getElementById("quarry-datasets")
        ?.addEventListener("click", datasetsClickHandler);
    document
        .getElementById(ADD_TO_EXISTING_TAG_ID)
        ?.addEventListener("change", (event) => {
            setAddToExistingTag((event.target as HTMLInputElement).checked);
        });
};

const installRequirements = (): void => {
    const button = document.getElementById(
        "quarry-install",
    ) as HTMLButtonElement | null;
    const status = document.getElementById("quarry-install-status");
    if (button) {
        button.disabled = true;
    }
    if (status) {
        status.textContent =
            "Installing… downloading the DuckDB lance extension (~235 MB). This can take a few minutes — please wait.";
    }
    genericRequest<InstallResponse>("QuarryInstallRequirements", {}, (data) => {
        if (data.success) {
            if (status) {
                status.textContent = "Installed! Loading…";
            }
            loadSettings();
        } else {
            if (button) {
                button.disabled = false;
            }
            if (status) {
                status.textContent = `Install failed: ${data.error ?? "unknown error"}`;
            }
        }
    });
};

const showInstallGate = (): void => {
    if (document.getElementById("quarry-install")) {
        return;
    }
    const host = document.getElementById(QUARRY_TAB_BODY_ID);
    if (!host) {
        return;
    }
    host.innerHTML = renderInstallGate();
    document
        .getElementById("quarry-install")
        ?.addEventListener("click", installRequirements);
};

const init = (): void => {
    const host = document.getElementById(QUARRY_TAB_BODY_ID);
    if (!host) {
        return;
    }
    host.innerHTML = `<div class="quarry-loading">Loading…</div>`;
    loadSettings();
    onReferences(applyTableHighlights);
};

export const quarry = {
    init,
};
