import { insertQuarryTag, onReferences, recomputeReferences } from "./prompt";
import { QUARRY_TAB_BODY_ID } from "./tab";
import type {
    DatasetDto,
    InstallResponse,
    PreviewResponse,
    SettingsResponse,
} from "./types";

const MESSAGE_TIMEOUT_MS = 5000;
export const PREVIEW_ROW_LIMIT = 100;
const PREVIEW_MODAL_ID = "quarry-preview-modal";
const PREVIEW_TITLE_ID = "quarry-preview-title";
const PREVIEW_BODY_ID = "quarry-preview-body";

export const escapeHtml = (text: string): string => {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
};

export const renderStatus = (active: boolean, count: number): string =>
    active
        ? `<span class="quarry-status-active">✓ Active — ${count} dataset(s)</span>`
        : `<span class="quarry-status-inactive">○ Inactive — enable and set a folder to activate</span>`;

export const renderDatasetOptions = (dataset: DatasetDto): string =>
    dataset.columns
        .map((col) => {
            const selected =
                col.name === dataset.resolvedPromptColumn ? " selected" : "";
            const badge = col.kind === "list" ? " [list]" : "";
            return `<option value="${escapeHtml(col.name)}"${selected}>${escapeHtml(col.name)}${badge}</option>`;
        })
        .join("");

export const renderTagCheckboxes = (dataset: DatasetDto): string =>
    dataset.columns
        .map((col) => {
            const checked = (dataset.configuredTagColumns ?? []).includes(
                col.name,
            )
                ? " checked"
                : "";
            const badge = col.kind === "list" ? " [list]" : "";
            return `<label class="quarry-tag-option"><input type="checkbox" class="quarry-dataset-tag" data-dataset="${escapeHtml(dataset.name)}" value="${escapeHtml(col.name)}"${checked}> ${escapeHtml(col.name)}${badge}</label>`;
        })
        .join("");

export const formatRowCount = (count: number | null | undefined): string =>
    count == null ? "—" : count.toLocaleString();

/// Toggles the "in prompt" highlight on each dataset row whose name (case-insensitive) is in `names`.
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

/// The dataset name rendered as a clickable control. Clicking it inserts (or toggles off) a `<q:NAME>`
/// reference in the prompt — the same behavior the old browser-tab cards had. `name` is already HTML-escaped.
export const renderDatasetNameButton = (name: string): string =>
    `<button type="button" class="quarry-dataset-name quarry-dataset-name-link" data-dataset="${name}" title="Add a reference to this dataset to your prompt">${name}</button>`;

export const renderDatasetRow = (dataset: DatasetDto): string => {
    const name = escapeHtml(dataset.name);
    if (dataset.error) {
        return `<tr class="quarry-dataset-row quarry-dataset-error" data-dataset="${name}">
            <td>${renderDatasetNameButton(name)}</td>
            <td colspan="4"><span class="quarry-dataset-error-msg">⚠️ ${escapeHtml(dataset.error)}</span></td>
        </tr>`;
    }
    return `<tr class="quarry-dataset-row" data-dataset="${name}">
        <td>${renderDatasetNameButton(name)}</td>
        <td><select class="quarry-dataset-column" data-dataset="${name}">${renderDatasetOptions(dataset)}</select></td>
        <td class="quarry-dataset-tags" title="Columns the 'tags' keyword searches across">${renderTagCheckboxes(dataset)}</td>
        <td class="quarry-dataset-rows" data-dataset="${name}" title="Rows in the dataset (loads when you preview it if not already counted)">${formatRowCount(dataset.rowCount)}</td>
        <td><button type="button" class="basic-button quarry-preview-button" data-dataset="${name}" title="Preview the first ${PREVIEW_ROW_LIMIT} rows">👁 Preview</button></td>
    </tr>`;
};

export const renderDatasets = (datasets: DatasetDto[]): string => {
    if (!datasets || datasets.length === 0) {
        return `<div class="quarry-datasets-empty">No datasets found. Set a folder containing CSV / JSON / JSONL / Parquet / Lance files, then Refresh.</div>`;
    }
    return `<table class="quarry-datasets-table">
        <thead>
            <tr><th>Dataset</th><th>Prompt column</th><th>Tag columns</th><th>Rows</th><th>Preview</th></tr>
        </thead>
        <tbody>${datasets.map(renderDatasetRow).join("")}</tbody>
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

export const renderForm = (enabled: boolean, folder: string): string => `
    <div class="quarry-settings">
        <form id="quarry-form">
            <div class="input-group input-group-open">
                <span class="input-group-header input-group-noshrink">
                    <span class="header-label-wrap"><span class="header-label">🦆 Quarry</span></span>
                </span>
                <div class="input-group-content">
                    <div class="auto-input auto-input-flex">
                        <span class="auto-input-name">Enable</span>
                        <label class="auto-checkbox">
                            <input type="checkbox" id="quarry-enabled" ${enabled ? "checked" : ""}>
                            <span class="auto-checkbox-label">Enable</span>
                        </label>
                    </div>
                    <div class="auto-input auto-input-flex">
                        <label for="quarry-folder"><span class="auto-input-name">Datasets folder</span></label>
                        <input class="auto-text" type="text" id="quarry-folder" value="${escapeHtml(folder)}" placeholder="/path/to/datasets" autocomplete="off">
                    </div>
                    <div id="quarry-status" class="quarry-status-line"></div>
                    <div class="quarry-actions">
                        <button type="button" id="quarry-refresh" class="basic-button">🔄 Refresh</button>
                    </div>
                    <div id="quarry-datasets" class="quarry-datasets"></div>
                </div>
            </div>
            <div id="quarry-message" class="quarry-message"></div>
            <div class="quarry-actions">
                <button type="submit" class="basic-button">Save Settings</button>
            </div>
        </form>
    </div>`;

/// The "install requirements" gate, shown instead of the panel until the DuckDB lance extension is installed.
/// A one-time download; the button triggers it and the status line reports progress/result.
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

export const collectPromptColumns = (
    container: HTMLElement,
): Record<string, string> => {
    const result: Record<string, string> = {};
    const selects = container.querySelectorAll<HTMLSelectElement>(
        "select.quarry-dataset-column",
    );
    selects.forEach((select) => {
        const name = select.getAttribute("data-dataset");
        if (name) {
            result[name] = select.value;
        }
    });
    return result;
};

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
        // Every dataset with at least one column gets an entry (even if nothing is checked) so that
        // clearing all of its tag columns is persisted as an empty list.
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

// Flags the dataset rows referenced by the current prompt; driven by the shared prompt watcher (prompt.ts).
const applyTableHighlights = (names: string[]): void => {
    const container = document.getElementById("quarry-datasets");
    if (container) {
        applyInPromptHighlights(container, names);
    }
};

const applyResponse = (data: SettingsResponse): void => {
    const enabledEl = document.getElementById(
        "quarry-enabled",
    ) as HTMLInputElement | null;
    const folderEl = document.getElementById(
        "quarry-folder",
    ) as HTMLInputElement | null;
    if (enabledEl) {
        enabledEl.checked = data.enabled ?? false;
    }
    if (folderEl) {
        folderEl.value = data.datasetsFolder ?? "";
    }
    const statusEl = document.getElementById("quarry-status");
    if (statusEl) {
        statusEl.innerHTML = renderStatus(
            data.active ?? false,
            data.count ?? 0,
        );
    }
    const datasetsEl = document.getElementById("quarry-datasets");
    if (datasetsEl) {
        datasetsEl.innerHTML = renderDatasets(data.datasets ?? []);
        // The table was just rebuilt (highlight classes wiped) — recompute against the current prompt.
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
    genericRequest<SettingsResponse>("QuarryGetSettings", {}, (data) => {
        if (!data.success) {
            return;
        }
        // Until the lance requirement is installed, show only the install gate — the panel can't read datasets.
        if (data.requirementsInstalled === false) {
            showInstallGate();
            return;
        }
        ensureFormRendered();
        applyResponse(data);
    });
};

const saveSettings = (): void => {
    const enabled = (
        document.getElementById("quarry-enabled") as HTMLInputElement
    ).checked;
    const folder = (
        document.getElementById("quarry-folder") as HTMLInputElement
    ).value.trim();
    const container = document.getElementById("quarry-datasets");
    const promptColumns = container ? collectPromptColumns(container) : {};
    const tagColumns = container ? collectTagColumns(container) : {};
    genericRequest<SettingsResponse>(
        "QuarrySaveSettings",
        {
            enabled,
            datasetsFolder: folder,
            promptColumnsJson: JSON.stringify(promptColumns),
            tagColumnsJson: JSON.stringify(tagColumns),
        },
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
    );
};

const refresh = (): void => {
    const button = document.getElementById(
        "quarry-refresh",
    ) as HTMLButtonElement | null;
    if (button) {
        button.disabled = true;
    }
    genericRequest<SettingsResponse>("QuarryRefresh", {}, (data) => {
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
    });
};

const ensurePreviewModal = (): void => {
    if (document.getElementById(PREVIEW_MODAL_ID)) {
        return;
    }
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.id = PREVIEW_MODAL_ID;
    modal.tabIndex = -1;
    modal.setAttribute("role", "dialog");
    modal.innerHTML = `
        <div class="modal-dialog modal-xl quarry-preview-dialog" role="document">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title" id="${PREVIEW_TITLE_ID}">Preview</h5>
                </div>
                <div class="modal-body">
                    <div id="${PREVIEW_BODY_ID}" class="quarry-preview-body"></div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary basic-button" data-bs-dismiss="modal">Close</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal
        .querySelector('[data-bs-dismiss="modal"]')
        ?.addEventListener("click", hidePreviewModal);
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

/// Fills in the lazily-loaded row count for a dataset wherever it is shown (the settings table's "Rows"
/// cell). The count arrives with the preview response, so this runs once the user has previewed the dataset.
const applyRowCount = (dataset: string, count: number | null): void => {
    const selector = `td.quarry-dataset-rows[data-dataset="${dataset.replace(/(["\\])/g, "\\$1")}"]`;
    for (const cell of Array.from(
        document.querySelectorAll<HTMLElement>(selector),
    )) {
        cell.textContent = formatRowCount(count);
    }
};

export const openPreview = (dataset: string): void => {
    ensurePreviewModal();
    const titleEl = document.getElementById(PREVIEW_TITLE_ID);
    const bodyEl = document.getElementById(PREVIEW_BODY_ID);
    if (titleEl) {
        titleEl.textContent = `Preview — ${dataset} (first ${PREVIEW_ROW_LIMIT} rows)`;
    }
    if (bodyEl) {
        bodyEl.innerHTML = `<div class="quarry-preview-loading">Loading…</div>`;
    }
    showPreviewModal();
    genericRequest<PreviewResponse>(
        "QuarryPreviewDataset",
        { dataset, limit: PREVIEW_ROW_LIMIT },
        (data) => {
            if (!bodyEl) {
                return;
            }
            if (data.success) {
                const count = data.rowCount ?? null;
                applyRowCount(dataset, count);
                const summary =
                    count == null
                        ? ""
                        : `<div class="quarry-preview-summary">${formatRowCount(count)} row(s).</div>`;
                bodyEl.innerHTML =
                    summary +
                    renderPreviewTable(data.columns ?? [], data.rows ?? []);
            } else {
                bodyEl.innerHTML = `<div class="quarry-preview-error">${escapeHtml(data.error ?? "Failed to load preview.")}</div>`;
            }
        },
    );
};

/// Click delegation for the datasets table: a preview button opens the preview modal; a dataset-name link
/// drops a `<q:NAME>` reference into the prompt (toggling it off if the cursor sits right after one we just
/// inserted) — the row's in-prompt highlight then follows via onReferences.
const datasetsClickHandler = (event: Event): void => {
    const target = event.target as HTMLElement | null;
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
    const nameButton = target?.closest<HTMLElement>(
        ".quarry-dataset-name-link",
    );
    if (nameButton) {
        const dataset = nameButton.getAttribute("data-dataset");
        if (dataset) {
            insertQuarryTag(dataset);
        }
    }
};

/// Renders the settings form into the tab body and wires its controls — once. A no-op when the form is already
/// present, so a settings reload updates values in place instead of rebuilding the form (and losing focus).
const ensureFormRendered = (): void => {
    if (document.getElementById("quarry-form")) {
        return;
    }
    const host = document.getElementById(QUARRY_TAB_BODY_ID);
    if (!host) {
        return;
    }
    host.innerHTML = renderForm(false, "");
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
        .getElementById("quarry-datasets")
        ?.addEventListener("click", datasetsClickHandler);
};

/// Triggers the one-time backend install of the DuckDB lance extension, then reloads settings — which swaps
/// the gate for the real panel once the requirement is satisfied.
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

/// Replaces the panel with the install-requirements gate and wires its button — once. A no-op when the gate is
/// already shown, so a re-check can't clobber an in-progress install's status text.
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
    // The Quarry panel lives in the bottom-bar Quarry tab (injected by tab.ts before this runs). Render a
    // placeholder, then loadSettings() fills in either the install gate or the real form, depending on whether
    // the lance requirement is satisfied.
    const host = document.getElementById(QUARRY_TAB_BODY_ID);
    if (!host) {
        return;
    }
    host.innerHTML = `<div class="quarry-loading">Loading…</div>`;
    loadSettings();
    // Keep the table's "in prompt" flags in sync with the shared prompt watcher (started in main.ts). The
    // prompt textareas live on the generate tab but persist in the DOM, so the table stays current even while
    // the Quarry settings panel is hidden. Registered once; applyTableHighlights no-ops until the table exists.
    onReferences(applyTableHighlights);
};

export const quarry = {
    init,
};
