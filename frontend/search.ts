import { IMAGE_SEARCH_BODY_ID } from "./searchtab";
import type {
    ImageFieldDto,
    ImageFieldsResponse,
    ImageSearchResponse,
    OperatorDto,
    ScanStartResponse,
    ScanStatusResponse,
} from "./types";
import { escapeHtml } from "./util";

const POLL_MS = 800;
const SEARCH_LIMIT = 2000;
const LOAD_MORE_SIZE = 1000;

export type OpType = "text" | "number" | "list" | "bool" | "discovered";

export interface FilterInput {
    field: string;
    op: string;
    value: string;
}

export type OperatorCatalog = Record<string, OperatorDto[]>;

export const operatorsForType = (
    catalog: OperatorCatalog,
    type: OpType,
): OperatorDto[] => catalog[type] ?? [];

export const opNeedsValue = (op: string): boolean =>
    op !== "is_true" && op !== "is_false";

export const buildSearchRequest = (rows: FilterInput[]): FilterInput[] =>
    rows
        .filter(
            (row) =>
                row.field &&
                row.op &&
                (!opNeedsValue(row.op) || row.value.trim() !== ""),
        )
        .map((row) => ({
            field: row.field,
            op: row.op,
            value: opNeedsValue(row.op) ? row.value : "",
        }));

export const rowToObject = (
    columns: string[],
    row: string[],
): Record<string, string> => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < columns.length; i++) {
        obj[columns[i]] = row[i] ?? "";
    }
    return obj;
};

export const resultsInfoText = (
    hasIndex: boolean,
    shown: number,
    total: number,
): string => {
    if (!hasIndex) {
        return "";
    }
    if (total === 0) {
        return "No matching images.";
    }
    if (shown < total) {
        return `Showing ${shown} of ${total} matches.`;
    }
    return `${total} match${total === 1 ? "" : "es"}.`;
};

export interface LoadMoreState {
    visible: boolean;
    disabled: boolean;
    label: string;
}

export const loadMoreState = (
    available: boolean,
    hasIndex: boolean,
    shown: number,
    total: number,
    pageSize: number,
    busy: boolean,
): LoadMoreState => {
    const remaining = total - shown;
    if (!available || !hasIndex || remaining <= 0) {
        return { visible: false, disabled: true, label: "" };
    }
    const next = Math.min(pageSize, remaining);
    return {
        visible: true,
        disabled: busy,
        label: busy ? "Loading…" : `Load ${next} more (${remaining} remaining)`,
    };
};

let coreFields: ImageFieldDto[] = [];
let discoveredFields: string[] = [];
let operatorCatalog: OperatorCatalog = {};
let available = true;
let hasIndex = false;
let total = 0;
let scanPollTimer: ReturnType<typeof setTimeout> | null = null;
let browser: GenPageBrowserClass | null = null;
let loadedFiles: BrowserFile[] = [];
let loadMoreBusy = false;
let searchPending = false;
let searchGeneration = 0;

const body = (): HTMLElement | null =>
    document.getElementById(IMAGE_SEARCH_BODY_ID);

const el = (id: string): HTMLElement | null => document.getElementById(id);

const request = <T>(
    url: string,
    data: Record<string, unknown>,
    onOk: (data: T) => void,
    onErr?: (message: string) => void,
): void => {
    genericRequest<T>(
        url,
        data,
        onOk,
        0,
        onErr
            ? (e) => onErr(typeof e === "string" ? e : "Request failed.")
            : null,
    );
};

const fieldOptionsHtml = (): string => {
    const core = coreFields
        .map(
            (field) =>
                `<option value="${escapeHtml(field.name)}" data-type="${field.type}">${escapeHtml(field.label)}</option>`,
        )
        .join("");
    const discovered = discoveredFields
        .map(
            (name) =>
                `<option value="${escapeHtml(name)}" data-type="discovered">${escapeHtml(name)}</option>`,
        )
        .join("");
    const discoveredGroup = discovered
        ? `<optgroup label="Discovered fields">${discovered}</optgroup>`
        : "";
    return `<optgroup label="Fields">${core}</optgroup>${discoveredGroup}`;
};

const opOptionsHtml = (type: OpType): string =>
    operatorsForType(operatorCatalog, type)
        .map(
            (op) =>
                `<option value="${escapeHtml(op.value)}">${escapeHtml(op.label)}</option>`,
        )
        .join("");

const filterRowHtml = (): string =>
    `<div class="imagesearch-filter-row">
        <select class="imagesearch-field auto-dropdown">${fieldOptionsHtml()}</select>
        <select class="imagesearch-op auto-dropdown">${opOptionsHtml(firstFieldType())}</select>
        <input type="text" class="imagesearch-value auto-text" placeholder="value" autocomplete="off">
        <button type="button" class="basic-button imagesearch-remove" title="Remove this filter">✕</button>
    </div>`;

const firstFieldType = (): OpType => (coreFields[0]?.type as OpType) ?? "text";

const skeletonHtml = (): string =>
    `<div class="imagesearch-top">
        <div class="imagesearch-header">
            <div class="imagesearch-title-row">
                <span class="imagesearch-title">Search your image history</span>
                <span class="imagesearch-scan-controls">
                    <button type="button" class="basic-button" id="imagesearch-rescan">Rescan history</button>
                    <button type="button" class="basic-button" id="imagesearch-cancel-scan" style="display:none">Cancel</button>
                </span>
            </div>
            <div class="imagesearch-progress quarry-dl-progress" id="imagesearch-progress" style="display:none">
                <div class="quarry-dl-bar" id="imagesearch-progress-bar"></div>
            </div>
            <div class="imagesearch-status" id="imagesearch-status"></div>
            <div class="imagesearch-notice" id="imagesearch-notice"></div>
        </div>
        <div class="imagesearch-controls" id="imagesearch-controls">
            <div class="imagesearch-filters" id="imagesearch-filters"></div>
            <div class="imagesearch-actions">
                <button type="button" class="basic-button" id="imagesearch-add-filter">+ Add filter</button>
                <span class="imagesearch-spacer"></span>
                <label for="imagesearch-sort">Sort:</label>
                <select id="imagesearch-sort" class="auto-dropdown">
                    <option value="date-desc">Newest first</option>
                    <option value="date-asc">Oldest first</option>
                    <option value="name-asc">Name A–Z</option>
                    <option value="name-desc">Name Z–A</option>
                </select>
                <button type="button" class="basic-button imagesearch-search-button" id="imagesearch-search">Search</button>
            </div>
        </div>
        <div class="imagesearch-results-info" id="imagesearch-results-info"></div>
    </div>
    <div class="browser_container imagesearch-results-browser" id="imagesearch-results-browser"></div>
    <div class="imagesearch-loadmore" id="imagesearch-loadmore" style="display:none">
        <button type="button" class="basic-button imagesearch-loadmore-button" id="imagesearch-loadmore-btn">Load more</button>
    </div>`;

const readFilters = (): FilterInput[] => {
    const rows: FilterInput[] = [];
    for (const row of Array.from(
        document.querySelectorAll<HTMLElement>(".imagesearch-filter-row"),
    )) {
        const field =
            row.querySelector<HTMLSelectElement>(".imagesearch-field")?.value ??
            "";
        const op =
            row.querySelector<HTMLSelectElement>(".imagesearch-op")?.value ??
            "";
        const value =
            row.querySelector<HTMLInputElement>(".imagesearch-value")?.value ??
            "";
        rows.push({ field, op, value });
    }
    return rows;
};

const sortParams = (): { sortBy: string; sortDescending: boolean } => {
    const value =
        (el("imagesearch-sort") as HTMLSelectElement | null)?.value ??
        "date-desc";
    const [sortBy, dir] = value.split("-");
    return { sortBy, sortDescending: dir !== "asc" };
};

const basename = (path: string): string => {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(slash + 1) : path;
};

const toBrowserFile = (obj: Record<string, string>): BrowserFile => {
    const path = obj.path ?? "";
    return {
        name: path,
        data: {
            src: `${getImageOutPrefix()}/${path}`,
            fullsrc: path,
            name: basename(path),
            metadata: obj.full_metadata ?? "",
        },
    };
};

const listResults = (
    _folder: string,
    _isRefresh: boolean,
    callback: (folders: string[], files: BrowserFile[]) => void,
    _depth: number,
): void => {
    searchGeneration++;
    searchPending = true;
    loadMoreBusy = false;
    if (!available) {
        loadedFiles = [];
        searchPending = false;
        updateResultsUI();
        callback([], []);
        return;
    }
    const { sortBy, sortDescending } = sortParams();
    const filters = buildSearchRequest(readFilters());
    request<ImageSearchResponse>(
        "QuarrySearchImageHistory",
        {
            filtersJson: JSON.stringify(filters),
            sortBy,
            sortDescending,
            limit: SEARCH_LIMIT,
            offset: 0,
        },
        (data) => {
            searchPending = false;
            available = data.available ?? true;
            hasIndex = data.hasIndex ?? false;
            total = data.total ?? 0;
            const columns = data.columns ?? [];
            loadedFiles = (data.rows ?? []).map((row) =>
                toBrowserFile(rowToObject(columns, row)),
            );
            updateResultsUI();
            reflectAvailability();
            applyWarnings(data.warnings ?? []);
            callback([], loadedFiles);
        },
        (message) => {
            searchPending = false;
            setNotice(message, "error");
            loadedFiles = [];
            updateResultsUI();
            callback([], []);
        },
    );
};

const selectResult = (file: BrowserFile, div: HTMLElement | null): void => {
    selectOutputInHistory(file, div);
    const results = el("imagesearch-results-browser");
    if (!results) {
        return;
    }
    for (const block of Array.from(
        results.getElementsByClassName("image-block"),
    )) {
        block.classList.toggle("image-block-current", block === div);
    }
};

const ensureBrowser = (): void => {
    if (browser) {
        return;
    }
    browser = new GenPageBrowserClass(
        "imagesearch-results-browser",
        listResults,
        "quarryimagesearch",
        "Thumbnails",
        describeOutputFile,
        selectResult,
    );
    browser.showDepth = false;
    browser.showUpFolder = false;
    browser.showFilter = false;
    browser.allowMultiSelect = true;
    body()?.addEventListener("scroll", () => {
        const scroller = body();
        if (scroller) {
            browserUtil.makeVisible(scroller);
        }
    });
};

const runSearch = (): void => {
    if (!available) {
        return;
    }
    ensureBrowser();
    browser?.lightRefresh();
    updateLoadMore();
};

const appendResults = (newFiles: BrowserFile[]): void => {
    const startId = loadedFiles.length;
    loadedFiles = loadedFiles.concat(newFiles);
    if (!browser?.contentDiv || newFiles.length === 0) {
        return;
    }
    browser.lastFiles = loadedFiles;
    if (browser.lastListCache) {
        browser.lastListCache.files = loadedFiles;
    }
    browser.buildContentList(browser.contentDiv, newFiles, null, startId);
    if (browser.headerCount) {
        browser.headerCount.textContent = String(loadedFiles.length);
    }
};

const loadMore = (): void => {
    if (
        !available ||
        searchPending ||
        loadMoreBusy ||
        loadedFiles.length >= total ||
        !browser?.contentDiv
    ) {
        return;
    }
    const gen = searchGeneration;
    loadMoreBusy = true;
    updateLoadMore();
    const { sortBy, sortDescending } = sortParams();
    const filters = buildSearchRequest(readFilters());
    request<ImageSearchResponse>(
        "QuarrySearchImageHistory",
        {
            filtersJson: JSON.stringify(filters),
            sortBy,
            sortDescending,
            limit: LOAD_MORE_SIZE,
            offset: loadedFiles.length,
        },
        (data) => {
            if (gen !== searchGeneration) {
                return;
            }
            loadMoreBusy = false;
            total = data.total ?? total;
            const columns = data.columns ?? [];
            appendResults(
                (data.rows ?? []).map((row) =>
                    toBrowserFile(rowToObject(columns, row)),
                ),
            );
            updateResultsUI();
        },
        (message) => {
            if (gen !== searchGeneration) {
                return;
            }
            loadMoreBusy = false;
            setNotice(message || "Could not load more results.", "error");
            updateLoadMore();
        },
    );
};

const setNotice = (
    text: string,
    type: "info" | "error" | "success" | "warning" = "info",
): void => {
    const notice = el("imagesearch-notice");
    if (notice) {
        notice.textContent = text;
        notice.className = text
            ? `imagesearch-notice imagesearch-notice-${type}`
            : "imagesearch-notice";
    }
};

const applyWarnings = (warnings: string[]): void => {
    if (warnings.length) {
        setNotice(warnings.join(" "), "warning");
    } else if (
        (el("imagesearch-notice")?.className ?? "").includes(
            "imagesearch-notice-warning",
        )
    ) {
        setNotice("");
    }
};

const updateResultsInfo = (): void => {
    const info = el("imagesearch-results-info");
    if (info) {
        info.textContent = resultsInfoText(hasIndex, loadedFiles.length, total);
    }
};

const updateLoadMore = (): void => {
    const wrap = el("imagesearch-loadmore");
    const button = el("imagesearch-loadmore-btn") as HTMLButtonElement | null;
    if (!wrap || !button) {
        return;
    }
    const state = loadMoreState(
        available,
        hasIndex,
        loadedFiles.length,
        total,
        LOAD_MORE_SIZE,
        loadMoreBusy || searchPending,
    );
    wrap.style.display = state.visible ? "" : "none";
    button.disabled = state.disabled;
    if (state.visible) {
        button.textContent = state.label;
    }
};

const updateResultsUI = (): void => {
    updateResultsInfo();
    updateLoadMore();
};

const reflectAvailability = (): void => {
    const controls = el("imagesearch-controls");
    const rescan = el("imagesearch-rescan") as HTMLButtonElement | null;
    const results = el("imagesearch-results-browser");
    const loadmore = el("imagesearch-loadmore");
    if (!available) {
        if (controls) {
            controls.style.display = "none";
        }
        if (results) {
            results.style.display = "none";
        }
        if (loadmore) {
            loadmore.style.display = "none";
        }
        if (rescan) {
            rescan.disabled = true;
        }
        setNotice(
            "Image Search needs Quarry's Lance reader. Open the Quarry tab and install requirements, then come back.",
            "error",
        );
        return;
    }
    if (rescan) {
        rescan.disabled = false;
    }
    if (controls) {
        controls.style.display = "";
    }
    if (results) {
        results.style.display = "";
    }
    if (!hasIndex) {
        setNotice(
            "Your image history hasn't been indexed yet. Click “Rescan history” to build the search index.",
            "info",
        );
    } else if (
        (el("imagesearch-notice")?.className ?? "").includes(
            "imagesearch-notice-info",
        )
    ) {
        setNotice("");
    }
};

const loadFields = (then?: () => void): void => {
    request<ImageFieldsResponse>(
        "QuarryImageHistoryFields",
        {},
        (data) => {
            if (data.success) {
                coreFields = data.coreFields ?? [];
                discoveredFields = data.discoveredFields ?? [];
                operatorCatalog = data.operators ?? {};
                available = data.available ?? true;
                hasIndex = data.hasIndex ?? false;
                refreshFieldDropdowns();
                reflectAvailability();
            }
            then?.();
        },
        (message) => {
            setNotice(message, "error");
            then?.();
        },
    );
};

const refreshFieldDropdowns = (): void => {
    for (const fieldSelect of Array.from(
        document.querySelectorAll<HTMLSelectElement>(".imagesearch-field"),
    )) {
        const previous = fieldSelect.value;
        fieldSelect.innerHTML = fieldOptionsHtml();
        if (Array.from(fieldSelect.options).some((o) => o.value === previous)) {
            fieldSelect.value = previous;
        }
    }
};

const addFilterRow = (): void => {
    const container = el("imagesearch-filters");
    if (!container) {
        return;
    }
    container.insertAdjacentHTML("beforeend", filterRowHtml());
};

const ensureOneFilterRow = (): void => {
    if (!document.querySelector(".imagesearch-filter-row")) {
        addFilterRow();
    }
};

const onFieldChanged = (row: HTMLElement): void => {
    const fieldSelect =
        row.querySelector<HTMLSelectElement>(".imagesearch-field");
    const opSelect = row.querySelector<HTMLSelectElement>(".imagesearch-op");
    const value = row.querySelector<HTMLInputElement>(".imagesearch-value");
    if (!fieldSelect || !opSelect) {
        return;
    }
    const selected = fieldSelect.options[fieldSelect.selectedIndex];
    const type = (selected?.getAttribute("data-type") as OpType) ?? "text";
    opSelect.innerHTML = opOptionsHtml(type);
    if (value) {
        value.style.display = opNeedsValue(opSelect.value) ? "" : "none";
    }
};

const onOpChanged = (row: HTMLElement): void => {
    const opSelect = row.querySelector<HTMLSelectElement>(".imagesearch-op");
    const value = row.querySelector<HTMLInputElement>(".imagesearch-value");
    if (opSelect && value) {
        value.style.display = opNeedsValue(opSelect.value) ? "" : "none";
    }
};

const setScanUI = (scanning: boolean): void => {
    const rescan = el("imagesearch-rescan") as HTMLButtonElement | null;
    const cancel = el("imagesearch-cancel-scan") as HTMLButtonElement | null;
    const progress = el("imagesearch-progress");
    if (rescan) {
        rescan.disabled = scanning;
    }
    if (cancel) {
        cancel.style.display = scanning ? "" : "none";
    }
    if (progress) {
        progress.style.display = scanning ? "" : "none";
    }
};

const renderScanStatus = (status: ScanStatusResponse): void => {
    const bar = el("imagesearch-progress-bar");
    const statusEl = el("imagesearch-status");
    const totalFiles = status.filesTotal ?? 0;
    const done = status.filesDone ?? 0;
    const percent =
        totalFiles > 0
            ? Math.min(100, Math.round((done / totalFiles) * 100))
            : 0;
    if (bar) {
        bar.style.width = `${percent}%`;
    }
    if (statusEl) {
        if (status.state === "scanning") {
            statusEl.textContent = `Scanning… ${done} / ${totalFiles} files (${status.filesIndexed ?? 0} indexed)`;
        } else if (status.state === "finalizing") {
            statusEl.textContent = "Writing index…";
        } else if (status.state === "starting") {
            statusEl.textContent = "Starting…";
        } else {
            statusEl.textContent = "";
        }
    }
};

const stopScanPolling = (): void => {
    if (scanPollTimer) {
        clearTimeout(scanPollTimer);
        scanPollTimer = null;
    }
};

const pollScanOnce = (): void => {
    scanPollTimer = null;
    request<ScanStatusResponse>(
        "QuarryImageHistoryStatus",
        {},
        (status) => {
            if (!status.success) {
                scanPollTimer = setTimeout(pollScanOnce, POLL_MS);
                return;
            }
            renderScanStatus(status);
            if (status.active) {
                scanPollTimer = setTimeout(pollScanOnce, POLL_MS);
                return;
            }
            finishScan(status);
        },
        () => {
            scanPollTimer = setTimeout(pollScanOnce, POLL_MS);
        },
    );
};

const finishScan = (status: ScanStatusResponse): void => {
    stopScanPolling();
    setScanUI(false);
    available = status.available ?? available;
    hasIndex = status.hasIndex ?? hasIndex;
    const statusEl = el("imagesearch-status");
    if (status.state === "error") {
        setNotice(
            `Scan failed: ${status.scanError ?? "unknown error"}`,
            "error",
        );
    } else if (status.state === "cancelled") {
        if (statusEl) {
            statusEl.textContent = "Scan cancelled.";
        }
    } else if (status.state === "done") {
        if (statusEl) {
            statusEl.textContent = `Done — indexed ${status.filesIndexed ?? 0}, pruned ${status.filesPruned ?? 0}.`;
        }
        loadFields(() => runSearch());
    }
};

const startRescan = (): void => {
    setScanUI(true);
    setNotice("");
    const statusEl = el("imagesearch-status");
    if (statusEl) {
        statusEl.textContent = "Starting…";
    }
    request<ScanStartResponse>(
        "QuarryRescanImageHistory",
        {},
        () => {
            if (!scanPollTimer) {
                pollScanOnce();
            }
        },
        (message) => {
            setScanUI(false);
            setNotice(message || "Could not start the scan.", "error");
        },
    );
};

const cancelRescan = (): void => {
    request<{ success: boolean }>(
        "QuarryCancelImageHistoryScan",
        {},
        () => {},
        () => {},
    );
};

const resumeScanIfActive = (): void => {
    request<ScanStatusResponse>(
        "QuarryImageHistoryStatus",
        {},
        (status) => {
            if (status.success && status.active) {
                setScanUI(true);
                renderScanStatus(status);
                if (!scanPollTimer) {
                    pollScanOnce();
                }
            }
        },
        () => {},
    );
};

const wireEvents = (): void => {
    if (!body()) {
        return;
    }
    el("imagesearch-add-filter")?.addEventListener("click", addFilterRow);
    el("imagesearch-search")?.addEventListener("click", runSearch);
    el("imagesearch-loadmore-btn")?.addEventListener("click", loadMore);
    el("imagesearch-rescan")?.addEventListener("click", startRescan);
    el("imagesearch-cancel-scan")?.addEventListener("click", cancelRescan);
    el("imagesearch-sort")?.addEventListener("change", runSearch);

    el("imagesearch-filters")?.addEventListener("change", (event) => {
        const target = event.target as HTMLElement | null;
        const row = target?.closest<HTMLElement>(".imagesearch-filter-row");
        if (!row) {
            return;
        }
        if (target?.classList.contains("imagesearch-field")) {
            onFieldChanged(row);
        } else if (target?.classList.contains("imagesearch-op")) {
            onOpChanged(row);
        }
    });
    el("imagesearch-filters")?.addEventListener("click", (event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest(".imagesearch-remove")) {
            target.closest(".imagesearch-filter-row")?.remove();
            ensureOneFilterRow();
        }
    });
    el("imagesearch-filters")?.addEventListener("keydown", (event) => {
        if ((event as KeyboardEvent).key === "Enter") {
            event.preventDefault();
            runSearch();
        }
    });
};

export const initImageSearch = (): void => {
    const container = body();
    if (!container || container.dataset.built === "true") {
        return;
    }
    container.dataset.built = "true";
    container.innerHTML = skeletonHtml();
    wireEvents();
    loadFields(() => {
        ensureOneFilterRow();
        if (available && hasIndex) {
            runSearch();
        }
        resumeScanIfActive();
    });
};
