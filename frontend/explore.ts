import { copyToClipboard } from "./clipboard";
import { datasetCompatibility, sharedExploreColumns } from "./exploreDatasets";
import { bindLibrarySplitter } from "./librarySplitter";
import { insertQuarryQuery, insertQuarryTag } from "./prompt";
import { querySections } from "./querysyntax";
import {
    clampMaxResults,
    renderResultRow,
    renderResultTable,
    renderRunQueryResponse,
    renderRunQueryResults,
} from "./runquery";
import type {
    ColumnDto,
    DatasetDto,
    ExploreColumnResponse,
    RunQueryResponse,
} from "./types";
import { escapeHtml } from "./util";

export interface ExploreFilter {
    column: string;
    operator: string;
    values: string[];
}
interface FilterRow {
    column: string;
    operator: string;
    value: string;
    term?: string;
}
interface ExploreDraft {
    queryText?: string;
    editingTag: boolean;
    filters: FilterRow[];
    outputs: string[];
    format: ExploreFormat;
}
export interface ExploreFormat {
    keys?: boolean;
    recordSeparator?: string;
    fieldSeparator?: string;
}
export const textOperators = [
    ["=", "Contains any"],
    ["==", "Contains all"],
    ["!=", "Contains none"],
];
const lengthOperators = [
    ["+=", "Length at least"],
    ["-=", "Length at most"],
];
const isComparison = (operator: string): boolean =>
    operator === "+=" || operator === "-=";
const numberOperators = [
    ["+=", "At least"],
    ["-=", "At most"],
];
const isNumber = (column: ColumnDto): boolean =>
    column?.kind === "scalar" && column.numeric === true;
export const canSuggestValue = (value: string): boolean =>
    value.trim().length > 0 && !/[,;[\]<>|]/.test(value);
// Escape tag delimiters as JSON Unicode escapes; the existing parser decodes them.
const quoteSeparator = (value: string): string =>
    JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
export const buildExploreQuery = (
    dataset: string,
    filters: ExploreFilter[],
    outputs: string[] = [],
    format: ExploreFormat = {},
): string => {
    const flags = [
        format.keys ? "keys" : "",
        format.recordSeparator !== undefined && format.recordSeparator !== ", "
            ? `rs=${quoteSeparator(format.recordSeparator)}`
            : "",
        format.fieldSeparator !== undefined && format.fieldSeparator !== ", "
            ? `fs=${quoteSeparator(format.fieldSeparator)}`
            : "",
    ].filter(Boolean);
    return `<q:${dataset}${filters.length ? `[${filters.map((filter) => `${filter.column}${filter.operator}${filter.values.join(",")}`).join(";")}]` : ""}${outputs.length ? `:${outputs.join(",")}` : ""}${flags.length ? `|${flags.join(";")}` : ""}>`;
};

interface LibraryOptions {
    overview?: boolean;
    onExpand?: () => void;
    renderWildcardToggle?: (dataset: DatasetDto) => string;
}

let valueListSequence = 0;

export const buildDatasetQuery = (datasets: DatasetDto[]): string | null =>
    datasets.some((dataset) => /[,;[\]<>|:*?]/.test(dataset.name))
        ? null
        : buildExploreQuery(
              datasets.map((dataset) => dataset.name).join(","),
              [],
          );

export class DatasetExplorer {
    private readonly valueListId = `quarry-values-${++valueListSequence}`;
    private selected = 0;
    private expandedView = "fields";
    private queryTextMode = false;
    private editingTag = false;
    private queryTextDraft: string | null = null;
    private sampleLimit = 100;
    private resultsLimit = 100;
    private overviewRequest = 0;
    private overviewSource = "";
    private filters: FilterRow[] = [];
    private outputs: string[] = [];
    private format: ExploreFormat = {};
    private fields: ColumnDto[];
    private datasets: DatasetDto[];
    private drafts = new Map<string, ExploreDraft>();
    private view = "fields";
    private settingsDirty = false;
    private datasetSearch = "";
    private combine = false;
    private disabledBrowseSelections = new Set<string>();
    private expandedNamespaces = new Set<string>();
    private openingNamespace: string;
    private request = 0;
    private draftQuery = "";
    private resultsQuery = "";
    private pendingQuery: string | null = null;
    private openValueRow: number | null = null;
    private disposed = false;
    private valueRequest = 0;
    private valueBusy = false;
    private valueSearch = "";
    private valueResponse: ExploreColumnResponse | null = null;
    private profiles = new Map<string, ExploreColumnResponse>();
    private valueMarkup = new WeakMap<HTMLElement, string>();
    private valueItems: string[] = [];
    private searchTimer: ReturnType<typeof setTimeout> | null = null;

    private splitterCleanup: () => void;
    private settingsCleanup: (() => void) | null = null;

    constructor(
        private readonly host: HTMLElement,
        private dataset: DatasetDto,
        private readonly renderRows: (
            columns: string[],
            rows: string[][],
        ) => string,
        private readonly close: () => void,
        private readonly newSample: () => void = () => {},
        private readonly onViewChange: (showRows: boolean) => void = () => {},
        private availableDatasets: DatasetDto[] = [dataset],
        private readonly onSourceChange: (
            source: DatasetDto,
            names: string[],
        ) => void = () => {},
        private readonly mountDatasetSettings?: (
            host: HTMLElement,
            dataset: DatasetDto,
            onSaved: (updated: DatasetDto) => void,
        ) => () => void,
        private readonly library: LibraryOptions = {},
    ) {
        this.view = library.overview ? "overview" : "fields";
        this.datasets = [dataset];
        this.openingNamespace = this.namespace(dataset.name);
        this.expandedNamespaces.add(this.openingNamespace);
        this.fields = sharedExploreColumns(this.datasets);
        this.filters = [this.blankFilter()];
        host.innerHTML = `<div class="quarry-explore">
            <nav class="quarry-explore-rail" aria-label="Dataset browser">
                <div class="quarry-explore-rail-search"><input type="search" class="quarry-explore-dataset-search auto-text" placeholder="Search all namespaces" aria-label="Search datasets"></div>
                <div class="quarry-explore-rail-modes" role="group" aria-label="Dataset selection mode">
                    <button type="button" class="basic-button" data-dataset-mode="browse" aria-pressed="true">Browse</button>
                    <button type="button" class="basic-button" data-dataset-mode="combine" aria-pressed="false">Combine</button>
                </div>
                <div class="quarry-explore-rail-list"></div>
                <div class="quarry-explore-rail-position quarry-explore-note" role="status"></div>
                <div class="quarry-explore-rail-actions">
                    <button type="button" class="basic-button" data-action="previous-dataset" aria-label="Previous dataset">‹ Previous</button>
                    <button type="button" class="basic-button" data-action="next-dataset" aria-label="Next dataset">Next ›</button>
                </div>
                <div class="splitter-bar quarry-library-splitter" role="separator" aria-label="Dataset sidebar width" aria-orientation="vertical" tabindex="0"></div>
            </nav>
            <div class="quarry-explore-top">
            <div class="quarry-explore-tabs" role="tablist" aria-label="Explore views">
                <button type="button" role="tab" class="quarry-explore-tab" data-view="fields" aria-pressed="true" aria-selected="true">Query</button>
                <button type="button" role="tab" class="quarry-explore-tab" data-view="rows" aria-pressed="false" aria-selected="false">Full records</button>
                <button type="button" role="tab" class="quarry-explore-tab" data-view="settings" aria-pressed="false" aria-selected="false">Dataset settings</button>
            </div>
            <div class="quarry-explore-scope"></div></div>
            <section class="quarry-library-overview" hidden>
                <div class="quarry-library-actions"><button type="button" class="basic-button" data-action="use-overview" title="Insert a separate tag at the prompt cursor">Add to prompt</button><button type="button" class="basic-button quarry-highlight-action" data-action="expand">Explore</button></div>
                <header class="quarry-library-header">
                    <button type="button" class="basic-button quarry-library-refresh" data-action="refresh-overview" title="Fetch 10 new sample records" aria-label="Refresh sample records">↻</button>
                    <div class="quarry-library-title"></div><div class="quarry-library-metadata"></div>
                </header>
                <div class="quarry-library-sample" aria-label="Sample records" aria-live="polite"></div>
            </section>
            <div class="quarry-explore-fields-view">
                <fieldset class="quarry-explore-editor" aria-label="Query controls">
                <section aria-label="Filters">
                    <h6 class="quarry-explore-section-label">Filters</h6>
                    <div class="quarry-explore-filters"></div>
                    <div class="quarry-explore-filter-actions"><button type="button" class="basic-button" data-action="add">+ Add filter</button><button type="button" class="basic-button" data-action="clear-filters">Clear filters</button></div>
                    <p class="quarry-explore-note">Text matching ignores case. Commas separate terms. All filter rows must match.</p>
                </section>
                <section class="quarry-explore-output" aria-label="Columns to print">
                    <label>Columns to print<select class="quarry-explore-output-add auto-dropdown" aria-label="Add column to print"><option value="">Add column…</option>${this.fields.map((column) => `<option value="${escapeHtml(column.name)}">${escapeHtml(column.name)}</option>`).join("")}</select></label>
                    <div class="quarry-explore-output-selected"></div>
                    <button type="button" class="basic-button quarry-explore-format-toggle" data-action="format" aria-expanded="false">Formatting options</button>
                </section>
                </fieldset>
            <div class="quarry-explore-draft">
                <div class="quarry-explore-error" role="status"></div>
                <div class="quarry-tag-heading"><span class="quarry-explore-note">Tag preview</span><button type="button" class="basic-button" data-action="edit-tag" aria-label="Edit query tag" title="Edit this tag directly"><span aria-hidden="true">✎</span> Edit</button><button type="button" class="basic-button" data-action="done-tag" hidden>Done Editing</button><button type="button" class="basic-button" data-action="use-builder" title="Replace this edited tag with the query from your filters and output choices" hidden>Restore query from filters</button></div>
                <code class="quarry-explore-query" aria-label="Tag preview"></code>
                <div class="quarry-query-text" hidden><textarea class="auto-text quarry-query-text-input" rows="3" aria-label="Query tag" spellcheck="false" placeholder="&lt;q:tags/**&gt;"></textarea></div>
                <div class="quarry-actions">
                    <button type="button" class="basic-button quarry-explore-primary" data-action="use">Add to prompt</button>
                    <button type="button" class="basic-button" data-action="test">Test query</button>
                    <button type="button" class="basic-button" data-action="copy">Copy tag</button>
                    <label class="quarry-query-limit">Max results<input type="number" class="auto-text" value="100" min="1" aria-label="Max results"></label>
                    <span class="quarry-explore-result-status quarry-explore-note" role="status"></span>
                </div>
                <p class="quarry-explore-note">Browsing does not change your prompt.</p>
                <div class="quarry-explore-results" aria-live="polite"></div>
            </div>
            </div>
            <div class="quarry-explore-rows-view" hidden><div class="quarry-explore-source"></div><div class="quarry-explore-rows" hidden></div></div>
            <div class="quarry-explore-settings-view" hidden><div class="quarry-explore-settings-source"></div><div class="quarry-explore-settings-content"></div></div>
            <div class="quarry-explore-field" aria-label="Value suggestions" hidden></div>
            <section class="quarry-explore-format-panel" aria-label="Formatting options" hidden>
                <div class="quarry-explore-popover-content">
                    <label class="quarry-explore-keys-label"><input class="quarry-explore-keys" type="checkbox"> Include field names</label>
                    <div class="quarry-format-setting"><label>Join selected columns with<textarea class="quarry-explore-record-separator auto-text" rows="1" aria-label="Record separator">, </textarea></label>
                    <p class="quarry-explore-note">Two columns: <code>prompt = portrait</code> and <code>style = watercolor</code>.<br>Printed text: <code class="quarry-explore-record-example"></code></p></div>
                    <div class="quarry-format-setting"><label>Separate nested JSON fields with<textarea class="quarry-explore-field-separator auto-text" rows="1" aria-label="Field separator">, </textarea></label>
                    <p class="quarry-explore-note">For a JSON column such as <code>prompt</code>: <code>{"hair":"blonde","expression":"smiling"}</code>.<br>Printing the whole column gives: <code class="quarry-explore-field-example"></code><br>Also separates values in a simple list.</p></div>
                </div>
            </section>
        </div>`;
        this.splitterCleanup = bindLibrarySplitter(
            this.element(".quarry-explore"),
        );
        this.element(".quarry-explore-editor").append(
            this.element(".quarry-explore-format-panel"),
        );
        host.addEventListener("click", this.click);
        document.addEventListener("click", this.outsideValues);
        document.addEventListener("focusin", this.outsideValues);
        window.addEventListener("resize", this.positionValues);
        host.addEventListener("scroll", this.positionValues, true);
        this.element(".quarry-explore-field").addEventListener(
            "scroll",
            this.scrollValues,
        );
        host.addEventListener("input", this.edit, true);
        host.addEventListener("change", this.edit, true);
        host.addEventListener("focusin", this.focus);
        host.addEventListener("keydown", this.keydown);
        host.addEventListener("dragstart", this.dragstart);
        host.addEventListener("dragover", this.dragover);
        host.addEventListener("drop", this.drop);
        host.addEventListener("dragend", this.clearDropMarker);
        host.addEventListener("dragleave", this.dragleave);
        this.renderScope();
        this.renderFilters();
        this.renderOutput();
        this.renderFormatExamples();
        this.selectRow(0);
        this.renderDraft();
        this.setView(library.overview ? "overview" : "fields");
    }
    dispose(): void {
        this.disposed = true;
        this.splitterCleanup();
        this.settingsCleanup?.();
        if (this.searchTimer) clearTimeout(this.searchTimer);
        this.host.removeEventListener("click", this.click);
        document.removeEventListener("click", this.outsideValues);
        document.removeEventListener("focusin", this.outsideValues);
        window.removeEventListener("resize", this.positionValues);
        this.host.removeEventListener("scroll", this.positionValues, true);
        this.element(".quarry-explore-field").removeEventListener(
            "scroll",
            this.scrollValues,
        );
        this.host.removeEventListener("input", this.edit, true);
        this.host.removeEventListener("change", this.edit, true);
        this.host.removeEventListener("focusin", this.focus);
        this.host.removeEventListener("keydown", this.keydown);
        this.host.removeEventListener("dragstart", this.dragstart);
        this.host.removeEventListener("dragover", this.dragover);
        this.host.removeEventListener("drop", this.drop);
        this.host.removeEventListener("dragend", this.clearDropMarker);
        this.host.removeEventListener("dragleave", this.dragleave);
    }
    get sourceName(): string {
        return this.dataset.name;
    }
    get elementHost(): HTMLElement {
        return this.host;
    }
    selectDataset(name: string): boolean {
        const dataset = this.availableDatasets.find(
            (item) => item.name === name,
        );
        if (!dataset || dataset.error || !dataset.columns.length) return false;
        if (dataset.name !== this.dataset.name || this.datasets.length !== 1)
            this.updateDatasets([dataset], true, true);
        return this.dataset.name === name && this.datasets.length === 1;
    }
    showOverview(): void {
        if (this.view !== "overview") this.expandedView = this.view;
        this.setView("overview");
    }
    expand(): void {
        this.setView(this.expandedView);
        if (this.view === "rows") this.newSample();
        else if (
            this.view === "fields" &&
            (this.resultsQuery !== this.draft().query ||
                this.resultsLimit !== this.sampleLimit)
        )
            this.testQuery();
    }
    private setQueryMode(text: boolean, query?: string, editing = text): void {
        if (text && !this.queryTextMode)
            this.queryTextDraft = query ?? this.draft().query;
        this.queryTextMode = text;
        this.editingTag = editing;
        this.closeAuxiliaryPanels();
        this.element<HTMLFieldSetElement>(".quarry-explore-editor").disabled =
            text;
        this.element<HTMLTextAreaElement>(".quarry-query-text-input").value =
            this.queryTextDraft ?? "";
        this.element(".quarry-explore-scope").hidden =
            text && this.view === "fields";
        this.renderTagEditor();
        this.renderDraft();
        if (text && editing)
            this.element<HTMLTextAreaElement>(
                ".quarry-query-text-input",
            ).focus();
        else if (!text) this.selectRow(this.selected);
    }
    private renderTagEditor(): void {
        this.element(".quarry-query-text").hidden = !this.editingTag;
        this.element(".quarry-explore-query").hidden = this.editingTag;
        this.element('[data-action="edit-tag"]').hidden = this.editingTag;
        this.element('[data-action="done-tag"]').hidden = !this.editingTag;
        this.element('[data-action="use-builder"]').hidden =
            !this.queryTextMode;
    }
    refreshMetadata(): void {
        this.renderRail();
        this.renderOverviewMetadata();
    }
    updateCatalog(datasets: DatasetDto[]): void {
        this.availableDatasets = datasets;
        this.dataset =
            datasets.find((item) => item.name === this.dataset.name) ??
            this.dataset;
        this.datasets = this.datasets
            .map((selected) =>
                datasets.find(
                    (item) =>
                        item.name === selected.name &&
                        !item.error &&
                        item.columns.length,
                ),
            )
            .filter((item): item is DatasetDto => !!item);
        this.fields = sharedExploreColumns(this.datasets);
        this.profiles.clear();
        this.valueRequest++;
        this.request++;
        this.pendingQuery = null;
        this.resultsQuery = "";
        this.element(".quarry-explore-results").replaceChildren();
        this.overviewSource = "";
        this.overviewRequest++;
        this.renderScope(!this.settingsDirty);
        this.renderFilters();
        this.renderOutput();
        this.renderDraft();
        this.refreshMetadata();
        if (this.view === "overview") this.loadOverview();
        else if (this.view === "fields") this.testQuery();
    }
    private renderOverviewMetadata(): void {
        const single = this.datasets.length === 1;
        const columns = single
            ? this.dataset.columns
            : sharedExploreColumns(this.datasets);
        const rows = this.datasets.every((dataset) => dataset.rowCount != null)
            ? `${this.datasets.reduce((total, dataset) => total + (dataset.rowCount ?? 0), 0).toLocaleString()} rows`
            : "Rows unknown";
        this.element(".quarry-library-title").innerHTML = this.datasets
            .map(
                (dataset) =>
                    `<button type="button" class="quarry-dataset-name quarry-dataset-name-link" data-prompt-dataset="${escapeHtml(dataset.name)}" title="Add or remove this dataset in the prompt"${buildDatasetQuery([dataset]) ? "" : " disabled"}>${escapeHtml(dataset.name)}</button>`,
            )
            .join(", ");
        this.element<HTMLButtonElement>(
            '[data-action="use-overview"]',
        ).disabled = !buildDatasetQuery(this.datasets);
        this.element(".quarry-library-metadata").innerHTML =
            `<div class="quarry-library-facts"><span>${rows}</span><span>${single ? "Columns" : "Shared columns"}: ${columns.map((column) => escapeHtml(column.name)).join(", ") || "—"}</span></div>${single && this.library.renderWildcardToggle ? `<div class="quarry-library-wildcard">${this.library.renderWildcardToggle(this.dataset)}<span>Include in wildcards</span></div>` : ""}`;
    }
    private loadOverview(refresh = false): void {
        this.renderOverviewMetadata();
        const query = buildDatasetQuery(this.datasets);
        if (!query) {
            this.overviewRequest++;
            this.overviewSource = "";
            this.element(".quarry-library-sample").textContent =
                "Open Explore to write a query for this dataset.";
            return;
        }
        if (!refresh && this.overviewSource === query) return;
        this.overviewSource = query;
        const request = ++this.overviewRequest;
        const region = this.element(".quarry-library-sample");
        region.textContent = "Loading sample…";
        genericRequest<RunQueryResponse>(
            "QuarryRunQuery",
            { query, maxResults: 10 },
            (data) => {
                if (this.disposed || request !== this.overviewRequest) return;
                if (data.error || data.invalid) {
                    region.textContent =
                        data.error || data.invalid || "Could not load sample.";
                    this.overviewSource = "";
                } else {
                    const rows = data.results ?? [];
                    region.innerHTML =
                        this.datasets.length === 1 && rows.length
                            ? renderResultTable(
                                  rows
                                      .map((row) =>
                                          renderResultRow(
                                              row.prompt,
                                              data.highlights ?? [],
                                          ),
                                      )
                                      .join(""),
                              )
                            : renderRunQueryResults(
                                  rows,
                                  data.highlights ?? [],
                              );
                }
            },
            0,
            () => {
                if (this.disposed || request !== this.overviewRequest) return;
                region.textContent =
                    "Could not load sample. Select the dataset again to retry.";
                this.overviewSource = "";
            },
        );
    }
    private setView(view: string): void {
        const previous = this.view;
        this.view = view;
        this.element(".quarry-explore-scope").hidden =
            this.queryTextMode && view === "fields";
        this.element(".quarry-explore").classList.toggle(
            "quarry-library-compact",
            view === "overview",
        );
        this.element(".quarry-library-overview").hidden = view !== "overview";
        this.element(".quarry-explore-top").hidden = view === "overview";
        this.element(".quarry-explore-tabs").hidden = view === "overview";
        this.element(".quarry-explore-rail-modes").hidden = view === "overview";
        if (view === "overview") this.loadOverview();
        if (view === "fields" && previous !== "fields")
            this.selectRow(this.selected);
        this.closeAuxiliaryPanels();
        this.renderRail();
        this.onViewChange(view === "rows");
        this.element(".quarry-explore-fields-view").hidden = view !== "fields";
        this.element(".quarry-explore-settings-view").hidden =
            view !== "settings";
        this.element(".quarry-explore-rows").hidden = view !== "rows";
        this.element(".quarry-explore-rows-view").hidden = view !== "rows";
        this.host
            .querySelectorAll<HTMLButtonElement>("[data-view]")
            .forEach((tab) => {
                tab.setAttribute(
                    "aria-pressed",
                    String(tab.dataset.view === view),
                );
                tab.setAttribute(
                    "aria-selected",
                    String(tab.dataset.view === view),
                );
                tab.tabIndex = tab.dataset.view === view ? 0 : -1;
            });
    }
    setRows(columns: string[], rows: string[][]): void {
        const region = this.element(".quarry-explore-rows");
        region.innerHTML = this.renderRows(columns, rows);
        const table = region.querySelector("table");
        if (table?.tHead) {
            // Size by displayed contents, regardless of column name or data type.
            const widths = columns.map((name, index) =>
                Math.max(
                    80,
                    Math.min(
                        360,
                        Math.max(
                            name.length,
                            ...rows.map((row) => (row[index] ?? "").length),
                        ) *
                            7 +
                            24,
                    ),
                ),
            );
            const width = widths.reduce((sum, value) => sum + value, 0);
            const colgroup = `<colgroup>${widths.map((width) => `<col style="width:${width}px">`).join("")}</colgroup>`;
            table.insertAdjacentHTML("afterbegin", colgroup);
            table.style.width = `max(100%, ${width}px)`;
            const header = document.createElement("div");
            header.className = "quarry-explore-table-header";
            header.setAttribute("aria-hidden", "true");
            const headerTable = table.cloneNode(false) as HTMLTableElement;
            headerTable.innerHTML = colgroup + table.tHead.outerHTML;
            header.append(headerTable);
            const scroll = document.createElement("div");
            scroll.className = "quarry-explore-table-scroll";
            scroll.tabIndex = 0;
            scroll.setAttribute("role", "region");
            scroll.setAttribute("aria-label", "Dataset rows");
            scroll.addEventListener("scroll", () => {
                header.scrollLeft = scroll.scrollLeft;
            });
            scroll.append(table);
            region.replaceChildren(header, scroll);
        }
    }
    private renderScope(resetSettings = true): void {
        this.expandedNamespaces.add(this.namespace(this.dataset.name));
        this.renderRail(true);
        this.element(".quarry-explore-scope").innerHTML = this.datasets
            .map(
                (dataset) =>
                    `<span class="quarry-explore-dataset-chip"><span>${escapeHtml(dataset.name)}</span>${this.datasets.length > 1 ? `<button type="button" class="basic-button" data-remove-dataset="${escapeHtml(dataset.name)}" aria-label="Remove dataset ${escapeHtml(dataset.name)}">×</button>` : ""}</span>`,
            )
            .join("");
        const source = this.element(".quarry-explore-source");
        source.hidden = this.datasets.length < 2;
        source.innerHTML = this.sourceSelector("Show rows from");
        const settingsSource = this.element(".quarry-explore-settings-source");
        settingsSource.hidden = this.datasets.length < 2;
        settingsSource.innerHTML = this.sourceSelector("Settings for");
        if (!resetSettings) return;
        this.settingsCleanup?.();
        this.settingsDirty = false;
        this.element('[data-view="settings"]').hidden =
            !this.mountDatasetSettings;
        this.settingsCleanup =
            this.mountDatasetSettings?.(
                this.element(".quarry-explore-settings-content"),
                this.dataset,
                (updated) => {
                    this.settingsDirty = false;
                    Object.assign(this.dataset, updated);
                    this.overviewSource = "";
                    this.overviewRequest++;
                    this.refreshMetadata();
                    if (this.view === "overview") this.loadOverview();
                    this.renderOutput();
                    this.resultsQuery = "";
                    this.request++;
                    this.pendingQuery = null;
                    this.renderDraft();
                    if (!this.queryTextMode && this.view === "fields")
                        this.testQuery();
                },
            ) ?? null;
    }
    private namespace(name: string): string {
        const slash = name.indexOf("/");
        return slash < 0 ? "" : name.slice(0, slash + 1);
    }
    private railDatasets(): DatasetDto[] {
        const namespace = this.namespace(this.dataset.name);
        return this.availableDatasets
            .filter(
                (dataset) =>
                    this.namespace(dataset.name) === namespace &&
                    !dataset.error &&
                    dataset.columns.length > 0 &&
                    (dataset.enabled !== false ||
                        this.disabledBrowseSelections.has(dataset.name) ||
                        dataset.name === this.dataset.name),
            )
            .sort((a, b) => a.name.localeCompare(b.name));
    }
    private usedColumns(): string[] {
        return [
            ...this.filters
                .filter((row) => row.value.trim())
                .map((row) => row.column),
            ...this.outputs,
        ];
    }
    private renderRail(revealCurrent = false): void {
        const list = this.element(".quarry-explore-rail-list");
        const scroll = list.scrollTop;
        const textScope = this.queryTextMode && this.view !== "overview";
        const search = this.datasetSearch.trim().toLowerCase();
        const groups = new Map<string, DatasetDto[]>();
        for (const dataset of [...this.availableDatasets].sort((a, b) =>
            a.name.localeCompare(b.name),
        )) {
            const namespace = this.namespace(dataset.name);
            if (!groups.has(namespace)) groups.set(namespace, []);
            groups.get(namespace)?.push(dataset);
        }
        const used = this.usedColumns();
        const selectedNames = new Set(
            this.datasets.map((dataset) => dataset.name),
        );
        list.innerHTML =
            [...groups]
                .sort(
                    ([a], [b]) =>
                        Number(b === this.openingNamespace) -
                            Number(a === this.openingNamespace) ||
                        a.localeCompare(b),
                )
                .map(([namespace, datasets], groupIndex) => {
                    const matches = datasets.filter((dataset) =>
                        dataset.name.toLowerCase().includes(search),
                    );
                    if (!matches.length) return "";
                    const selected = datasets.filter((dataset) =>
                        selectedNames.has(dataset.name),
                    ).length;
                    const open =
                        !!search || this.expandedNamespaces.has(namespace);
                    const groupId = `quarry-explore-namespace-${groupIndex}`;
                    const rows = matches
                        .map((dataset, rowIndex) => {
                            const name = escapeHtml(dataset.name);
                            const label = escapeHtml(
                                dataset.name.slice(namespace.length),
                            );
                            const included = selectedNames.has(dataset.name);
                            const disabled = dataset.enabled === false;
                            const unavailable =
                                dataset.error ||
                                (!dataset.columns.length
                                    ? "Dataset has no available fields."
                                    : "");
                            const reason =
                                this.combine && this.view !== "overview"
                                    ? included
                                        ? ""
                                        : datasetCompatibility(
                                              dataset,
                                              this.fields,
                                              used,
                                          )
                                    : unavailable;
                            const locked =
                                included && this.datasets.length === 1;
                            const reasonId = `${groupId}-reason-${rowIndex}`;
                            const metadata = [
                                dataset.rowCount == null
                                    ? "Rows unknown"
                                    : `${dataset.rowCount.toLocaleString()} rows`,
                                ...dataset.columns
                                    .filter(
                                        (column) =>
                                            column.name.toLowerCase() !==
                                            "prompt",
                                    )
                                    .map((column) => column.name),
                                ...(disabled ? ["Wildcards off"] : []),
                            ].join(" · ");
                            const content = `<span>${label}<small class="quarry-explore-dataset-metadata">${escapeHtml(metadata)}</small></span>`;
                            const control =
                                this.combine && this.view !== "overview"
                                    ? `<label class="quarry-explore-dataset-choice ${included ? "is-selected" : ""}"><input type="checkbox" data-include-dataset="${name}" aria-label="Include ${name} in query" ${included ? "checked" : ""} ${reason || locked || textScope ? "disabled" : ""} ${reason ? `aria-describedby="${reasonId}"` : ""}>${content}</label>`
                                    : `<button type="button" class="basic-button" data-browse-dataset="${name}" aria-current="${dataset.name === this.dataset.name}" ${unavailable ? `disabled aria-describedby="${reasonId}"` : ""}>${content}</button>`;
                            return `<div class="quarry-explore-rail-row${disabled ? " is-disabled-dataset" : ""}"${disabled ? ' title="Excluded from wildcards. You can still select this dataset explicitly."' : ""}>${control}${reason ? `<small id="${reasonId}">${escapeHtml(reason)}</small>` : ""}</div>`;
                        })
                        .join("");
                    return `<section class="quarry-explore-namespace"><button type="button" class="quarry-explore-namespace-toggle" data-namespace="${escapeHtml(namespace)}" aria-expanded="${open}" aria-controls="${groupId}"><span>${escapeHtml(namespace ? namespace.slice(0, -1) : "Root")}</span><small>${search ? `${matches.length} of ` : ""}${datasets.length} datasets${selected ? ` · ${selected} selected` : ""}</small></button><div id="${groupId}" class="quarry-explore-namespace-items" ${open ? "" : "hidden"}>${rows}</div></section>`;
                })
                .join("") ||
            '<p class="quarry-explore-note">No datasets match.</p>';
        list.scrollTop = scroll;
        const datasets = this.railDatasets();
        const index = datasets.findIndex(
            (item) => item.name === this.dataset.name,
        );
        const combined = this.datasets.length > 1;
        this.host
            .querySelectorAll<HTMLButtonElement>("[data-dataset-mode]")
            .forEach((button) => {
                button.disabled =
                    textScope && button.dataset.datasetMode === "combine";
                button.setAttribute(
                    "aria-pressed",
                    String(
                        (button.dataset.datasetMode === "combine") ===
                            this.combine,
                    ),
                );
            });
        const position = this.element(".quarry-explore-rail-position");
        position.textContent = textScope
            ? "Query text controls dataset scope."
            : combined
              ? `${this.datasets.length} selected. Choose one in Browse to use it alone.`
              : "";
        position.hidden = !position.textContent;
        this.element<HTMLButtonElement>(
            '[data-action="previous-dataset"]',
        ).disabled =
            combined ||
            (this.combine && this.view !== "overview") ||
            index <= 0;
        this.element<HTMLButtonElement>(
            '[data-action="next-dataset"]',
        ).disabled =
            combined ||
            (this.combine && this.view !== "overview") ||
            index < 0 ||
            index === datasets.length - 1;
        if (revealCurrent && !search) {
            const current = list.querySelector<HTMLElement>(
                '[data-browse-dataset][aria-current="true"]',
            );
            if (current) {
                const header = current
                    .closest(".quarry-explore-namespace")
                    ?.querySelector(".quarry-explore-namespace-toggle");
                const bounds = list.getBoundingClientRect();
                const card = current.getBoundingClientRect();
                const top =
                    bounds.top + (header?.getBoundingClientRect().height ?? 0);
                if (card.top < top) list.scrollTop += card.top - top;
                else if (card.bottom > bounds.bottom)
                    list.scrollTop += card.bottom - bounds.bottom;
            }
        }
    }

    private confirmSettingsChange(): boolean {
        return (
            !this.settingsDirty ||
            window.confirm(
                "Discard unsaved dataset settings and switch datasets?",
            )
        );
    }
    private sourceSelector(label: string): string {
        return `<label>${label}<select class="auto-dropdown quarry-explore-source-select" aria-label="${label}">${this.datasets.map((dataset) => `<option value="${escapeHtml(dataset.name)}" ${dataset.name === this.dataset.name ? "selected" : ""}>${escapeHtml(dataset.name)}</option>`).join("")}</select></label>`;
    }
    private chooseDatasets(): void {
        this.closeAuxiliaryPanels();
        this.element<HTMLInputElement>(
            ".quarry-explore-dataset-search",
        ).focus();
    }
    private updateDatasets(
        datasets: DatasetDto[],
        reset: boolean,
        browse = false,
    ): void {
        if (!this.confirmSettingsChange()) return;
        const previous = this.dataset.name;
        if (!reset) {
            for (const dataset of datasets) {
                if (
                    dataset.enabled === false &&
                    !this.datasets.some((item) => item.name === dataset.name)
                )
                    this.disabledBrowseSelections.add(dataset.name);
            }
            for (const dataset of this.datasets) {
                if (!datasets.some((item) => item.name === dataset.name))
                    this.disabledBrowseSelections.delete(dataset.name);
            }
        }
        const key = (sources: DatasetDto[]) =>
            JSON.stringify(sources.map((source) => source.name).sort());
        this.drafts.set(key(this.datasets), {
            queryText: this.queryTextMode
                ? (this.queryTextDraft ?? "")
                : undefined,
            editingTag: this.editingTag,
            filters: this.filters.map((filter) => ({ ...filter })),
            outputs: [...this.outputs],
            format: { ...this.format },
        });
        if (this.queryTextMode) this.setQueryMode(false);
        this.datasets = datasets;
        this.dataset =
            datasets.find((dataset) => dataset.name === previous) ??
            datasets[0];
        this.fields = sharedExploreColumns(datasets);
        const saved = this.drafts.get(key(datasets));
        const draft =
            (reset && browse) || saved?.queryText !== undefined
                ? saved
                : undefined;
        if (reset || draft) {
            this.filters = draft?.filters.map((filter) => ({ ...filter })) ?? [
                this.blankFilter(),
            ];
            this.outputs = draft ? [...draft.outputs] : [];
            this.format = { ...draft?.format };
            this.element<HTMLInputElement>(".quarry-explore-keys").checked =
                !!this.format.keys;
            this.element<HTMLTextAreaElement>(
                ".quarry-explore-record-separator",
            ).value = this.format.recordSeparator ?? ", ";
            this.element<HTMLTextAreaElement>(
                ".quarry-explore-field-separator",
            ).value = this.format.fieldSeparator ?? ", ";
            this.closeAuxiliaryPanels();
            this.element(".quarry-explore-format-panel").hidden = true;
            this.element('[data-action="format"]').setAttribute(
                "aria-expanded",
                "false",
            );
        } else {
            // Empty draft rows are not query clauses and can follow the shared schema.
            this.filters = this.filters.map((row) => {
                const field = this.fields.find(
                    (field) =>
                        field.name.toLowerCase() === row.column.toLowerCase(),
                );
                return field
                    ? { ...row, column: field.name }
                    : this.blankFilter();
            });
            this.outputs = this.outputs.map(
                (name) =>
                    this.fields.find(
                        (field) =>
                            field.name.toLowerCase() === name.toLowerCase(),
                    )?.name ?? name,
            );
        }
        this.selected = Math.min(this.selected, this.filters.length - 1);
        this.resultsQuery = "";
        this.element(".quarry-explore-results").replaceChildren();
        if (previous !== this.dataset.name) {
            this.element(".quarry-explore-rows").textContent =
                "Loading dataset rows…";
        }
        this.renderScope();
        this.renderFilters();
        this.renderOutput();
        this.renderFormatExamples();
        this.selectRow(this.selected);
        if (saved?.queryText !== undefined)
            this.setQueryMode(true, saved.queryText, saved.editingTag);
        this.renderDraft();
        this.setView(browse ? this.view : "fields");
        this.onSourceChange(
            this.dataset,
            datasets.map((dataset) => dataset.name),
        );
        if (this.view !== "overview") this.testQuery();
    }
    private changeSource(name: string): void {
        const dataset = this.datasets.find((dataset) => dataset.name === name);
        if (!dataset || dataset.name === this.dataset.name) return;
        if (!this.confirmSettingsChange()) {
            this.host
                .querySelectorAll<HTMLSelectElement>(
                    ".quarry-explore-source-select",
                )
                .forEach((select) => {
                    select.value = this.dataset.name;
                });
            return;
        }
        this.dataset = dataset;
        this.renderScope();

        this.element(".quarry-explore-rows").textContent =
            "Loading dataset rows…";
        this.selectRow(this.selected);
        this.onSourceChange(
            dataset,
            this.datasets.map((selected) => selected.name),
        );
    }
    private renderResults(data: RunQueryResponse): void {
        const results = this.element(".quarry-explore-results");
        if (data.error || data.invalid) {
            results.innerHTML = `<p class="quarry-preview-error">${escapeHtml(data.error ?? data.invalid ?? "Query failed.")}</p>`;
            return;
        }
        const rows = data.results ?? [];
        const total = data.total ?? 0;
        const breakdown =
            this.datasets.length > 1 && data.datasets?.length
                ? `<details><summary>Matches by dataset</summary>${data.datasets.map((dataset) => `<div>${escapeHtml(dataset.name)} · ${dataset.matches.toLocaleString()} matches</div>`).join("")}</details>`
                : "";
        const multiple = this.datasets.length > 1;
        const table = rows.length
            ? renderResultTable(
                  rows
                      .map((row) =>
                          renderResultRow(
                              row.prompt,
                              data.highlights ?? [],
                              multiple
                                  ? `<button type="button" class="quarry-explore-query-dataset quarry-explore-result-source" data-action="choose-datasets">${escapeHtml(row.dataset)}</button>`
                                  : "",
                          ),
                      )
                      .join(""),
              )
            : `<p class="quarry-preview-empty">${total > 0 ? "Matching rows were counted, but no sample output was returned." : "No matching rows."}</p>`;
        results.innerHTML = `<div class="quarry-explore-result-summary"><h6>Results</h6><span>${rows.length.toLocaleString()} random result${rows.length === 1 ? "" : "s"} · ${total.toLocaleString()} matches</span>${breakdown}</div><div class="quarry-explore-result-heading">${multiple ? `${this.datasets.length} datasets` : `<button type="button" class="quarry-explore-query-dataset" data-action="choose-datasets" title="Switch dataset or add another dataset">${escapeHtml(this.dataset.name)}</button>`}</div><div class="quarry-explore-result-scroll" tabindex="0" role="region" aria-label="Query results">${table}</div>`;
    }
    private closeAuxiliaryPanels(): void {
        this.element(".quarry-explore-field").hidden = true;

        this.openValueRow = null;
        this.host
            .querySelectorAll(
                "[aria-expanded][data-values-row], .quarry-explore-value[aria-expanded]",
            )
            .forEach((button) => {
                button.setAttribute("aria-expanded", "false");
            });
    }
    private renderFormatExamples(): void {
        const keys = this.format.keys;
        this.element(".quarry-explore-record-example").textContent = [
            keys ? "prompt: portrait" : "portrait",
            keys ? "style: watercolor" : "watercolor",
        ].join(this.format.recordSeparator ?? ", ");
        this.element(".quarry-explore-field-example").textContent = [
            keys ? "hair: blonde" : "blonde",
            keys ? "expression: smiling" : "smiling",
        ].join(this.format.fieldSeparator ?? ", ");
    }
    private renderQuerySuffix(suffix: string): string {
        if (!this.outputs.length) return escapeHtml(suffix);
        const start = suffix.startsWith("[") ? suffix.indexOf("]") + 1 : 0;
        const tokens = this.outputs
            .map(
                (name, index) =>
                    `<span class="quarry-explore-output-token" data-output-index="${index}" draggable="true" tabindex="0" title="Drag to reorder. Alt+Left/Right also moves this column."><span class="quarry-output-grip" aria-hidden="true"></span>${escapeHtml(name)}<button type="button" class="quarry-output-remove" data-remove-output="${index}" aria-label="Remove output ${escapeHtml(name)}"></button></span>`,
            )
            .join(",");
        return (
            escapeHtml(suffix.slice(0, start + 1)) +
            tokens +
            escapeHtml(suffix.slice(start + 1 + this.outputs.join(",").length))
        );
    }
    private moveOutput(from: number, to: number): void {
        if (
            !Number.isInteger(from) ||
            !Number.isInteger(to) ||
            from === to ||
            from < 0 ||
            to < 0 ||
            from >= this.outputs.length ||
            to >= this.outputs.length
        )
            return;
        const [column] = this.outputs.splice(from, 1);
        this.outputs.splice(to, 0, column);
        this.renderOutput();
        this.renderDraft();
        this.element<HTMLElement>(`[data-output-index="${to}"]`).focus();
    }
    private dragstart = (event: DragEvent): void => {
        const token = (event.target as HTMLElement).closest<HTMLElement>(
            "[data-output-index]",
        );
        if (token && event.dataTransfer) {
            event.dataTransfer.setData(
                "application/x-quarry-output",
                token.dataset.outputIndex ?? "",
            );
            event.dataTransfer.effectAllowed = "move";
        }
    };
    private clearDropMarker = (): void => {
        this.host.querySelectorAll("[data-drop-edge]").forEach((token) => {
            token.removeAttribute("data-drop-edge");
        });
    };
    private dragleave = (event: DragEvent): void => {
        const token = (event.target as HTMLElement).closest(
            "[data-output-index]",
        );
        if (token && !token.contains(event.relatedTarget as Node | null))
            this.clearDropMarker();
    };
    private dragover = (event: DragEvent): void => {
        const token = (event.target as HTMLElement).closest<HTMLElement>(
            "[data-output-index]",
        );
        if (
            !token ||
            !event.dataTransfer?.types.includes("application/x-quarry-output")
        )
            return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        this.clearDropMarker();
        const rect = token.getBoundingClientRect();
        token.dataset.dropEdge =
            event.clientX < rect.left + rect.width / 2 ? "before" : "after";
    };
    private drop = (event: DragEvent): void => {
        const token = (event.target as HTMLElement).closest<HTMLElement>(
            "[data-output-index]",
        );
        const source = event.dataTransfer?.getData(
            "application/x-quarry-output",
        );
        if (!token || !source) return;
        event.preventDefault();
        const from = Number(source);
        const rect = token.getBoundingClientRect();
        const after = event.clientX >= rect.left + rect.width / 2;
        const insertion = Number(token.dataset.outputIndex) + (after ? 1 : 0);
        this.clearDropMarker();
        this.moveOutput(from, insertion > from ? insertion - 1 : insertion);
    };
    private keydown = (event: KeyboardEvent): void => {
        const target = event.target as HTMLElement;
        if (
            (event.ctrlKey || event.metaKey) &&
            event.key === "Enter" &&
            this.view === "fields"
        ) {
            event.preventDefault();
            this.testQuery();
            return;
        }
        const valueInput = target.matches(".quarry-explore-value");
        const inValues = this.element(".quarry-explore-field").contains(target);
        if (valueInput && event.key === "Tab") {
            this.commitTerm();
            this.closeAuxiliaryPanels();
        }
        if (
            valueInput &&
            event.key === "Enter" &&
            this.profile(this.filters[this.selected])?.eligible
        ) {
            event.preventDefault();
            this.commitTerm();
            this.valueSearch = "";
            if (this.searchTimer) clearTimeout(this.searchTimer);
            this.loadValues();
            return;
        }
        if (
            (valueInput || inValues) &&
            this.profile(this.filters[this.selected])?.eligible &&
            !this.smallValues(this.filters[this.selected]).length &&
            ["ArrowDown", "ArrowUp"].includes(event.key)
        ) {
            event.preventDefault();
            this.openValues();
            const options = Array.from(
                this.element(
                    ".quarry-explore-field",
                ).querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
            );
            const index = options.indexOf(target as HTMLButtonElement);
            options[
                (index < 0
                    ? event.key === "ArrowDown"
                        ? 0
                        : options.length - 1
                    : index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      options.length) % options.length
            ]?.focus();
            return;
        }
        if (event.key === "Escape" && this.openValueRow !== null) {
            event.preventDefault();
            event.stopPropagation();
            this.element<HTMLInputElement>(
                `[data-row="${this.selected}"] .quarry-explore-value`,
            ).focus();
            this.closeAuxiliaryPanels();
            return;
        }
        const token = target.closest<HTMLElement>("[data-output-index]");
        if (
            token &&
            event.altKey &&
            ["ArrowLeft", "ArrowRight"].includes(event.key)
        ) {
            event.preventDefault();
            const from = Number(token.dataset.outputIndex);
            this.moveOutput(from, from + (event.key === "ArrowLeft" ? -1 : 1));
            return;
        }
        if (
            event.key === "Escape" &&
            target.matches(".quarry-explore-dataset-search") &&
            this.datasetSearch
        ) {
            event.preventDefault();
            event.stopPropagation();
            this.datasetSearch = "";
            (target as HTMLInputElement).value = "";
            this.renderRail();
            return;
        }
        if (
            event.key === "Escape" &&
            !this.element(".quarry-explore-format-panel").hidden
        ) {
            event.preventDefault();
            event.stopPropagation();
            this.element(".quarry-explore-format-panel").hidden = true;
            this.element('[data-action="format"]').setAttribute(
                "aria-expanded",
                "false",
            );
            this.element<HTMLButtonElement>('[data-action="format"]').focus();
            return;
        }
        if (
            target.matches("[data-view]") &&
            ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
        ) {
            event.preventDefault();
            const views = Array.from(
                this.host.querySelectorAll<HTMLElement>("[data-view]"),
            )
                .filter((tab) => !tab.hidden)
                .map((tab) => tab.dataset.view as string);
            const index = views.indexOf(target.dataset.view ?? "fields");
            const view =
                event.key === "Home"
                    ? views[0]
                    : event.key === "End"
                      ? views[views.length - 1]
                      : views[
                            (index +
                                (event.key === "ArrowRight" ? 1 : -1) +
                                views.length) %
                                views.length
                        ];
            const tab = this.element<HTMLButtonElement>(
                `[data-view="${view}"]`,
            );
            tab.focus();
            tab.click();
        }
    };
    private element<T extends HTMLElement = HTMLElement>(selector: string): T {
        const element = this.host.querySelector<T>(selector);
        if (!element) throw new Error(`Missing Explore control: ${selector}`);
        return element;
    }
    private blankFilter(): FilterRow {
        const column = this.fields[0];
        return {
            column: column?.name ?? "",
            operator: isNumber(column) ? "+=" : "=",
            value: "",
        };
    }
    private activeColumn(): ColumnDto | undefined {
        return this.fields.find(
            (column) => column.name === this.filters[this.selected]?.column,
        );
    }
    private renderFilters(): void {
        this.filters = this.filters.map((filter) => {
            const column = this.fields.find(
                (field) =>
                    field.name.toLowerCase() === filter.column.toLowerCase(),
            );
            return column
                ? { ...filter, column: column.name }
                : filter.value.trim() || filter.term?.trim()
                  ? filter
                  : this.blankFilter();
        });
        this.element<HTMLButtonElement>('[data-action="add"]').disabled =
            !this.fields.length;
        this.element(".quarry-explore-filters").innerHTML = this.filters
            .map((filter, index) => {
                const column = this.fields.find(
                    (field) => field.name === filter.column,
                );
                const operators = isNumber(column)
                    ? numberOperators
                    : column?.kind === "scalar"
                      ? [...textOperators, ...lengthOperators]
                      : textOperators;
                const numericInput =
                    isNumber(column) || isComparison(filter.operator);
                return `<div class="quarry-explore-filter-row ${index === this.selected ? "active" : ""}" data-row="${index}">
                <select class="quarry-explore-column auto-dropdown" aria-label="Field ${index + 1}">${column ? "" : `<option value="${escapeHtml(filter.column)}" selected disabled>${escapeHtml(filter.column)} (unavailable)</option>`}${this.fields.map((field) => `<option value="${escapeHtml(field.name)}" ${field.name === filter.column ? "selected" : ""}>${escapeHtml(field.name)}</option>`).join("")}</select>
                <select class="quarry-explore-operator auto-dropdown" aria-label="Match ${index + 1}">${operators.map(([value, label]) => `<option value="${value}" ${value === filter.operator ? "selected" : ""}>${label}</option>`).join("")}</select>
                <div class="quarry-explore-value-control"><div class="quarry-explore-inline-values" hidden></div><div class="quarry-explore-terms"></div><input ${column ? "" : "disabled"} class="quarry-explore-value auto-text" aria-label="Value ${index + 1}" type="${numericInput ? "number" : "text"}" ${numericInput ? (isNumber(column) ? 'step="any"' : 'step="1" min="0"') : ""} placeholder="${isNumber(column) ? "Number" : numericInput ? "Character count" : "Search terms"}" value="${escapeHtml(filter.value)}">
                <button type="button" class="basic-button quarry-explore-values-toggle" data-values-row="${index}" aria-expanded="false" hidden aria-label="Value suggestions">⌄</button></div>
                <button type="button" class="basic-button" data-remove="${index}" ${this.filters.length === 1 ? "hidden" : ""} aria-label="Remove filter ${index + 1}">×</button>
            </div>`;
            })
            .join("");
        this.updateValueInputs();
    }
    private profile(row: FilterRow): ExploreColumnResponse | undefined {
        return isComparison(row.operator)
            ? undefined
            : this.profiles.get(`${this.dataset.name}:${row.column}`);
    }
    private smallValues(row: FilterRow): string[] {
        const profile = this.profile(row);
        const values = [
            ...new Set((profile?.values ?? []).map((value) => value.trim())),
        ];
        return profile?.eligible &&
            !profile.hasMore &&
            (profile.totalValues ?? values.length) <= 6 &&
            values.every(
                (value) => value.length <= 12 && canSuggestValue(value),
            )
            ? values
            : [];
    }
    private updateValueMarkup(element: HTMLElement, markup: string): void {
        if (this.valueMarkup.get(element) === markup) return;
        element.innerHTML = markup;
        this.valueMarkup.set(element, markup);
    }
    private updateValueInputs(): void {
        this.filters.forEach((filter, index) => {
            const selector = `[data-row="${index}"]`;
            const profile = this.profile(filter);
            const adaptive = !!profile?.eligible;
            const small = this.smallValues(filter);
            const chosen = this.values(filter.value);
            const input = this.element<HTMLInputElement>(
                `${selector} .quarry-explore-value`,
            );
            const control = this.element<HTMLElement>(
                `${selector} .quarry-explore-value-control`,
            );
            control.classList.toggle("adaptive", adaptive);
            const terms = this.element<HTMLElement>(
                `${selector} .quarry-explore-terms`,
            );
            const termsHtml = adaptive
                ? chosen
                      .filter((value) => !small.includes(value))
                      .map(
                          (value) =>
                              `<button type="button" class="quarry-explore-term" data-remove-term="${escapeHtml(value)}" aria-label="Remove ${escapeHtml(value)}">${escapeHtml(value)}<span aria-hidden="true">×</span></button>`,
                      )
                      .join("")
                : "";
            this.updateValueMarkup(terms, termsHtml);
            const chips = this.element<HTMLElement>(
                `${selector} .quarry-explore-inline-values`,
            );
            const focusedValue = chips.contains(document.activeElement)
                ? (document.activeElement as HTMLElement).dataset.value
                : undefined;
            const chipsHtml = small
                .map(
                    (value) =>
                        `<button type="button" class="basic-button" data-value="${escapeHtml(value)}" aria-pressed="${chosen.includes(value)}">${escapeHtml(value)}</button>`,
                )
                .join("");
            this.updateValueMarkup(chips, chipsHtml);
            if (focusedValue !== undefined)
                Array.from(
                    chips.querySelectorAll<HTMLButtonElement>("[data-value]"),
                )
                    .find((button) => button.dataset.value === focusedValue)
                    ?.focus({ preventScroll: true });
            chips.hidden = !small.length;
            const text = adaptive ? (filter.term ?? "") : filter.value;
            if (input.value !== text) input.value = text;
            if (!isComparison(filter.operator))
                input.placeholder = adaptive
                    ? small.length
                        ? "Or type a term…"
                        : "Type or select…"
                    : "Search terms";
            const expanded = index === this.openValueRow;
            input.setAttribute("aria-expanded", String(expanded));
            if (adaptive && !small.length) {
                input.setAttribute("aria-controls", this.valueListId);
            } else {
                input.removeAttribute("aria-controls");
                input.removeAttribute("aria-expanded");
            }
            const button = this.element<HTMLButtonElement>(
                `${selector} [data-values-row]`,
            );
            button.hidden =
                !(adaptive && !small.length) && profile?.success !== false;
            button.textContent = profile?.success === false ? "↻" : "⌄";
            button.setAttribute(
                "aria-label",
                profile?.success === false
                    ? "Retry value suggestions"
                    : `Suggestions for ${filter.column}`,
            );
            button.setAttribute("aria-expanded", String(expanded));
        });
    }
    private commitTerm(index = this.selected): void {
        const row = this.filters[index];
        if (!row?.term) return;
        row.value = [
            ...new Set([...this.values(row.value), ...this.values(row.term)]),
        ].join(", ");
        row.term = "";
        this.updateValueInputs();
        this.renderDraft();
    }
    private selectRow(index: number): void {
        this.commitTerm();
        this.closeAuxiliaryPanels();
        if (this.searchTimer) clearTimeout(this.searchTimer);
        this.selected = index;
        this.host.querySelectorAll<HTMLElement>("[data-row]").forEach((row) => {
            row.classList.toggle("active", Number(row.dataset.row) === index);
        });
        this.valueRequest++;
        this.valueSearch = "";
        this.valueResponse = null;
        this.valueItems = [];
        this.valueBusy = false;
        this.renderDiscovery();
        this.loadValues();
    }
    private renderDiscovery(): void {
        this.element(".quarry-explore-field").innerHTML =
            `${this.datasets.length > 1 ? `<div class="quarry-explore-value-source">${this.sourceSelector("Suggestions from")}</div>` : ""}<div class="quarry-explore-suggestions" role="group" aria-label="Suggested search terms" id="${this.valueListId}"></div>`;
        this.renderSuggestions();
    }
    private openValues(): void {
        const row = this.filters[this.selected];
        if (!this.profile(row)?.eligible || this.smallValues(row).length)
            return;
        const search = row.term ?? "";
        if (this.valueSearch !== search) {
            this.valueSearch = search;
            if (this.searchTimer) clearTimeout(this.searchTimer);
            this.loadValues();
        }
        this.openValueRow = this.selected;
        this.element(".quarry-explore-field").hidden = false;
        this.updateValueInputs();
        this.positionValues();
    }
    private positionValues = (): void => {
        if (this.openValueRow === null) return;
        const control = this.element(
            `[data-row="${this.openValueRow}"] .quarry-explore-value-control`,
        );
        const rect = control.getBoundingClientRect();
        const pane = this.element(".quarry-explore-field");
        const below = window.innerHeight - rect.bottom - 12;
        const above = rect.top - 12;
        const upwards = below < 180 && above > below;
        pane.style.width = `${Math.min(rect.width, window.innerWidth - 16)}px`;
        pane.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8))}px`;
        pane.style.maxHeight = `${Math.max(80, Math.min(300, upwards ? above : below))}px`;
        pane.style.top = upwards ? "auto" : `${rect.bottom + 4}px`;
        pane.style.bottom = upwards
            ? `${window.innerHeight - rect.top + 4}px`
            : "auto";
    };
    private outsideValues = (event: Event): void => {
        const path = event.composedPath();
        if (
            path.includes(this.element(".quarry-explore-field")) ||
            path.some(
                (item) =>
                    item instanceof Element &&
                    item.matches(".quarry-explore-value-control"),
            )
        )
            return;
        if (event.type === "click") this.commitTerm();
        this.closeAuxiliaryPanels();
    };
    private scrollValues = (event: Event): void => {
        if (event.target !== this.element(".quarry-explore-field")) return;
        const pane = event.target as HTMLElement;
        if (
            !this.valueBusy &&
            this.valueResponse?.hasMore &&
            pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 40
        )
            this.loadValues(true);
    };
    private renderOutput(): void {
        this.element<HTMLSelectElement>(
            ".quarry-explore-output-add",
        ).innerHTML =
            '<option value="">Add column…</option>' +
            this.fields
                .filter((column) => !this.outputs.includes(column.name))
                .map(
                    (column) =>
                        `<option value="${escapeHtml(column.name)}">${escapeHtml(column.name)}</option>`,
                )
                .join("");
        this.element(".quarry-explore-output-selected").textContent = this
            .outputs.length
            ? this.outputs.length > 1
                ? "Drag column tags in the query to reorder."
                : ""
            : `Dataset default: ${this.datasets.length === 1 ? (this.dataset.resolvedPromptColumn ?? "first available column") : "each dataset’s default output"}`;
    }
    private focus = (event: Event): void => {
        const row = (event.target as HTMLElement).closest<HTMLElement>(
            "[data-row]",
        );
        if (row && Number(row.dataset.row) !== this.selected)
            this.selectRow(Number(row.dataset.row));
        if ((event.target as HTMLElement).matches(".quarry-explore-value"))
            this.openValues();
    };
    private edit = (event: Event): void => {
        const target = event.target as HTMLInputElement;
        if (target.dataset.includeDataset !== undefined) {
            if (event.type !== "change" || target.disabled || !this.combine)
                return;
            this.commitTerm();
            const name = target.dataset.includeDataset;
            const dataset = this.availableDatasets.find(
                (item) => item.name === name,
            );
            if (!dataset) return;
            if (target.checked) {
                if (
                    this.datasets.some((item) => item.name === name) ||
                    datasetCompatibility(
                        dataset,
                        this.fields,
                        this.usedColumns(),
                    )
                )
                    return;
                this.updateDatasets([...this.datasets, dataset], false);
            } else if (this.datasets.length > 1) {
                this.updateDatasets(
                    this.datasets.filter((item) => item.name !== name),
                    false,
                );
            }
            // A cancelled settings confirmation must also restore the checkbox.
            this.renderRail();
            [
                ...this.host.querySelectorAll<HTMLInputElement>(
                    "[data-include-dataset]",
                ),
            ]
                .find((input) => input.dataset.includeDataset === name)
                ?.focus({ preventScroll: true });
            return;
        }
        if (target.closest(".quarry-explore-settings-content")) {
            this.settingsDirty = true;
            return;
        }
        if (target.matches(".quarry-query-text-input")) {
            if (event.type === "input") {
                this.queryTextDraft = target.value;
                this.renderDraft();
            }
            return;
        }
        if (target.matches(".quarry-query-limit input")) {
            this.sampleLimit = clampMaxResults(target.value);
            if (event.type === "change")
                target.value = String(this.sampleLimit);
            this.request++;
            this.pendingQuery = null;
            this.renderDraft();
            return;
        }
        if (target.matches(".quarry-explore-dataset-search")) {
            if (event.type !== "input") return;
            this.datasetSearch = target.value;
            this.renderRail();
            return;
        }
        if (target.matches(".quarry-explore-source-select")) {
            if (event.type === "change") this.changeSource(target.value);
            return;
        }
        if (this.queryTextMode && target.closest(".quarry-explore-editor"))
            return;
        const row = target.closest<HTMLElement>("[data-row]");
        if (row) {
            const index = Number(row.dataset.row);
            const filter = this.filters[index];
            if (target.matches(".quarry-explore-column")) {
                if (event.type !== "change") return;
                filter.column = target.value;
                filter.operator = isNumber(
                    this.fields.find((field) => field.name === filter.column),
                )
                    ? "+="
                    : "=";
                filter.value = "";
                filter.term = "";
                this.closeAuxiliaryPanels();
                this.renderFilters();
                this.selectRow(index);
                this.element<HTMLSelectElement>(
                    `[data-row="${index}"] .quarry-explore-column`,
                ).focus();
            } else if (target.matches(".quarry-explore-operator")) {
                if (event.type !== "change") return;
                this.commitTerm(index);
                const changedType =
                    isComparison(filter.operator) !==
                    isComparison(target.value);
                filter.operator = target.value;
                if (changedType) {
                    filter.value = "";
                    filter.term = "";
                    this.closeAuxiliaryPanels();
                }
                this.renderFilters();
                if (changedType && !isComparison(filter.operator))
                    this.loadValues();
                this.element<HTMLSelectElement>(
                    `[data-row="${index}"] .quarry-explore-operator`,
                ).focus();
            } else if (target.matches(".quarry-explore-value")) {
                if (event.type !== "input") return;
                if (index !== this.selected) this.selectRow(index);
                if (this.profile(filter)?.eligible) {
                    filter.term = target.value;
                    if (target.value.includes(",")) this.commitTerm(index);
                    this.valueSearch = filter.term ?? "";
                    if (this.searchTimer) clearTimeout(this.searchTimer);
                    this.valueRequest++;
                    if (!this.smallValues(filter).length) {
                        this.valueBusy = true;
                        this.valueItems = [];
                        this.openValues();
                        this.searchTimer = setTimeout(
                            () => this.loadValues(),
                            250,
                        );
                    }
                } else filter.value = target.value;
                this.renderSuggestions();
            }
        } else if (target.matches(".quarry-explore-output-add")) {
            if (!target.value || event.type !== "change") return;
            if (!this.outputs.includes(target.value))
                this.outputs.push(target.value);
            target.value = "";
            this.renderOutput();
        } else if (target.matches(".quarry-explore-keys")) {
            this.format.keys = target.checked;
        } else if (target.matches(".quarry-explore-record-separator")) {
            this.format.recordSeparator = target.value;
        } else if (target.matches(".quarry-explore-field-separator")) {
            this.format.fieldSeparator = target.value;
        } else return;
        this.renderFormatExamples();
        this.renderDraft();
    };
    private loadValues(append = false): void {
        if (this.view !== "fields" || this.queryTextMode) return;
        const column = this.activeColumn();
        if (
            !column ||
            isNumber(column) ||
            isComparison(this.filters[this.selected].operator) ||
            column.kind !== "scalar" ||
            !this.dataset.columns.some(
                (source) =>
                    source.name.toLowerCase() === column.name.toLowerCase(),
            )
        )
            return;
        const request = ++this.valueRequest;
        const search = this.valueSearch;
        const offset = append ? this.valueItems.length : 0;
        this.valueBusy = true;
        this.renderSuggestions();
        const receive = (data: ExploreColumnResponse): void => {
            if (this.disposed || request !== this.valueRequest) return;
            if (
                append &&
                data.success &&
                data.revision !== this.valueResponse?.revision
            ) {
                this.valueItems = [];
                this.loadValues();
                return;
            }
            this.valueBusy = false;
            this.valueResponse = data;
            if (!search && !append)
                this.profiles.set(`${this.dataset.name}:${column.name}`, data);
            this.valueItems = data.success
                ? append
                    ? [...this.valueItems, ...(data.values ?? [])]
                    : (data.values ?? [])
                : [];
            this.renderSuggestions();
        };
        genericRequest<ExploreColumnResponse>(
            "QuarryExploreColumn",
            { dataset: this.dataset.name, column: column.name, search, offset },
            receive,
            0,
            () =>
                receive({
                    success: false,
                    error: "Could not check this column. Try again.",
                }),
        );
    }

    private renderSuggestions(): void {
        this.updateValueInputs();
        const area = this.host.querySelector<HTMLElement>(
            ".quarry-explore-suggestions",
        );
        if (!area) return;
        const pane = this.element(".quarry-explore-field");
        const scroll = pane.scrollTop;
        const focused =
            document.activeElement instanceof HTMLElement
                ? document.activeElement.dataset.value
                : undefined;
        const data = this.valueResponse;
        if (!data) {
            area.textContent = this.valueBusy ? "Loading suggestions…" : "";
            return;
        }
        if (!data.success) {
            area.innerHTML = `<span class="quarry-explore-error">${escapeHtml(data.error ?? "Could not load suggestions.")}</span><button type="button" class="basic-button" data-action="retry-values">Retry</button>`;
            return;
        }
        if (
            !data.eligible ||
            this.smallValues(this.filters[this.selected]).length
        ) {
            pane.hidden = true;
            area.replaceChildren();
            return;
        }
        const chosen = this.readValues();
        area.innerHTML =
            this.valueItems
                .map(
                    (value) =>
                        `<button type="button" class="quarry-explore-value-option" data-value="${escapeHtml(value.trim())}" aria-pressed="${chosen.includes(value.trim())}" ${canSuggestValue(value) ? "" : 'disabled title="Contains query separators; type a shorter term instead."'}><span aria-hidden="true">${chosen.includes(value.trim()) ? "✓" : ""}</span>${escapeHtml(value)}</button>`,
                )
                .join("") +
            (this.valueSearch.trim() &&
            canSuggestValue(this.valueSearch) &&
            !this.valueItems.some(
                (value) =>
                    value.toLowerCase() ===
                    this.valueSearch.trim().toLowerCase(),
            )
                ? `<button type="button" class="quarry-explore-custom-term" data-action="add-term">Use “${escapeHtml(this.valueSearch.trim())}” as a search term</button>`
                : "") +
            `<div class="quarry-explore-value-status" role="status">${this.valueBusy ? "Loading suggestions…" : this.valueItems.length ? `${this.valueItems.length.toLocaleString()} of ${(data.matchingValues ?? this.valueItems.length).toLocaleString()} values` : "No matching values. Type a term and press Enter."}</div>`;
        if (focused !== undefined)
            Array.from(area.querySelectorAll<HTMLButtonElement>("[data-value]"))
                .find((button) => button.dataset.value === focused)
                ?.focus({ preventScroll: true });
        pane.scrollTop = scroll;
        this.positionValues();
    }

    private readValues(): string[] {
        return this.values(this.filters[this.selected]?.value ?? "");
    }
    private values(value: string): string[] {
        return value
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
    }
    private draft(): { query: string; error: string } {
        if (this.queryTextMode) {
            const text = this.queryTextDraft?.trim() ?? "";
            if (!text)
                return {
                    query: "",
                    error: "Enter a query tag or its inner text.",
                };
            if (
                text.startsWith("<") &&
                !/^<q(?:\[\d+(?:-\d+)?\])?:[^<>]+>$/i.test(text)
            )
                return {
                    query: "",
                    error: "Enter a complete <q:…> query tag.",
                };
            return {
                query: text,
                error: "",
            };
        }
        const filters: ExploreFilter[] = [];
        for (const [index, row] of this.filters.entries()) {
            const values = this.values(row.value);
            if (!values.length) continue;
            if (!this.fields.some((field) => field.name === row.column))
                return {
                    query: "",
                    error: "Choose a field shared by the selected datasets.",
                };
            if (
                values.some((value) => !canSuggestValue(value)) ||
                /[=,;[\]<>|:]/.test(row.column)
            )
                return {
                    query: "",
                    error: `Filter ${index + 1} contains query separators. Enter shorter search terms.`,
                };
            const column = this.fields.find(
                (field) => field.name === row.column,
            );
            if (
                isComparison(row.operator) &&
                (values.length !== 1 ||
                    !Number.isFinite(Number(values[0])) ||
                    (!isNumber(column) &&
                        (!Number.isInteger(Number(values[0])) ||
                            Number(values[0]) < 0)))
            )
                return {
                    query: "",
                    error: `Filter ${index + 1} needs ${isNumber(column) ? "a valid number" : "a whole character count of zero or more"}.`,
                };
            filters.push({
                column: row.column,
                operator: row.operator,
                values,
            });
        }
        if (
            this.datasets.some((dataset) =>
                /[,;[\]<>|:*?]/.test(dataset.name),
            ) ||
            this.outputs.some((column) => /[,;[\]<>|:]/.test(column))
        )
            return {
                query: "",
                error: "This dataset or column name contains query separators. Use Edit beside Tag preview to write the query manually.",
            };
        return {
            query: buildExploreQuery(
                this.datasets.map((dataset) => dataset.name).join(","),
                filters,
                this.outputs,
                this.format,
            ),
            error: "",
        };
    }
    private promptTag(): { query: string; error: string } {
        const draft = this.draft();
        if (draft.error || !this.queryTextMode || draft.query.startsWith("<"))
            return draft;
        const pipe = querySections(draft.query).pipe;
        const inner =
            pipe < 0
                ? draft.query
                : draft.query.slice(0, pipe) +
                  draft.query
                      .slice(pipe)
                      .replace(/"(?:\\.|[^"\\])*"/g, (quoted) =>
                          quoted
                              .replace(/</g, "\\u003c")
                              .replace(/>/g, "\\u003e"),
                      );
        if (/[<>]/.test(inner))
            return {
                query: "",
                error: "This query can be tested, but unquoted angle brackets cannot be inserted in a prompt tag.",
            };
        return { query: `<q:${inner}>`, error: "" };
    }
    private renderDraft(): void {
        this.renderRail();
        const { query, error } = this.draft();
        if (query !== this.draftQuery) {
            this.request++;
            this.pendingQuery = null;
            this.draftQuery = query;
        }
        const tag = this.promptTag();
        this.element(".quarry-explore-error").textContent = error || tag.error;
        const names = this.datasets.map((dataset) => dataset.name);
        this.element(".quarry-explore-query").innerHTML = this.queryTextMode
            ? escapeHtml(tag.query || query)
            : query
              ? "&lt;q:" +
                names
                    .map(
                        (name) =>
                            `<button type="button" class="quarry-explore-query-dataset" data-action="choose-datasets" title="Switch dataset or add another dataset">${escapeHtml(name)}</button>`,
                    )
                    .join(",") +
                this.renderQuerySuffix(query.slice(3 + names.join(",").length))
              : "";
        this.element(".quarry-explore-result-status").textContent =
            this.resultsQuery &&
            (this.resultsQuery !== query ||
                this.resultsLimit !== this.sampleLimit)
                ? "Results from the last test. Test query to update."
                : this.pendingQuery
                  ? "Drawing random matches…"
                  : this.resultsQuery
                    ? ""
                    : "Test query to preview these settings.";
        this.element('[data-action="copy"]').textContent = "Copy tag";
        for (const action of ["test", "use", "copy"])
            this.element<HTMLButtonElement>(
                `[data-action="${action}"]`,
            ).disabled =
                !!error ||
                (action !== "test" && !!tag.error) ||
                (action === "test" && this.pendingQuery === query);
    }
    testQuery(): void {
        const { query, error } = this.draft();
        if (error || this.pendingQuery === query) return;
        const request = ++this.request;
        const limit = this.sampleLimit;
        this.pendingQuery = query;
        const button = this.element<HTMLButtonElement>('[data-action="test"]');
        button.disabled = true;
        this.element(".quarry-explore-result-status").textContent =
            "Drawing random matches…";
        genericRequest<RunQueryResponse>(
            "QuarryRunQuery",
            { query, maxResults: this.sampleLimit },
            (data) => {
                if (this.disposed || request !== this.request) return;
                button.disabled = false;
                this.pendingQuery = null;
                this.resultsQuery = query;
                this.resultsLimit = limit;
                this.element(".quarry-explore-result-status").textContent = "";
                if (this.queryTextMode) {
                    const result = renderRunQueryResponse(data);
                    this.element(".quarry-explore-results").innerHTML =
                        `<code class="quarry-query-tested">${escapeHtml(query)}</code>${result.summary}<div class="quarry-explore-result-scroll" tabindex="0" role="region" aria-label="Query results">${result.body}</div>`;
                } else this.renderResults(data);
            },
            0,
            () => {
                if (this.disposed || request !== this.request) return;
                button.disabled = false;
                this.pendingQuery = null;
                this.element(".quarry-explore-result-status").textContent =
                    "Query failed. Try again.";
            },
        );
    }
    private async copy(text: string, button: HTMLButtonElement): Promise<void> {
        const tag = button.dataset.action === "copy";
        button.disabled = true;
        if (tag) button.textContent = "Copying…";
        const copied = await copyToClipboard(text, this.host);
        if (this.disposed || !button.isConnected) return;
        if (tag && this.promptTag().query !== text) return;
        button.disabled = false;
        if (tag) button.textContent = copied ? "Copied" : "Copy tag";
        if (copied) {
            if (typeof doNoticePopover === "function")
                doNoticePopover(
                    "Copied!",
                    "notice-pop-green quarry-copy-notice",
                );
        } else {
            this.element(".quarry-explore-result-status").textContent =
                "Copy failed. Select the text and copy it manually.";
        }
    }
    private click = (event: Event): void => {
        const target = event.target as HTMLElement;
        this.outsideValues(event);
        if (target.matches(".quarry-explore-value")) this.openValues();
        const button = target.closest<HTMLButtonElement>("button");
        if (!button || button.disabled) return;
        if (button.dataset.action === "edit-tag") {
            this.setQueryMode(true);
        } else if (button.dataset.action === "done-tag") {
            if (this.promptTag().error) {
                this.renderDraft();
                return;
            }
            this.editingTag = false;
            this.renderTagEditor();
            this.element('[data-action="edit-tag"]').focus();
        } else if (button.dataset.action === "use-builder") {
            this.setQueryMode(false);
            this.element('[data-action="edit-tag"]').focus();
        } else if (button.dataset.promptDataset) {
            insertQuarryTag(button.dataset.promptDataset);
        } else if (button.dataset.action === "refresh-overview") {
            this.loadOverview(true);
        } else if (button.dataset.action === "use-overview") {
            const query = buildDatasetQuery(this.datasets);
            if (query) insertQuarryQuery(query);
        } else if (button.dataset.action === "expand") {
            this.library.onExpand?.();
        } else if (button.dataset.namespace !== undefined) {
            const open = button.getAttribute("aria-expanded") === "true";
            button.setAttribute("aria-expanded", String(!open));
            const items = button.parentElement?.querySelector<HTMLElement>(
                ".quarry-explore-namespace-items",
            );
            if (items) items.hidden = open;
            if (!this.datasetSearch.trim()) {
                if (open)
                    this.expandedNamespaces.delete(button.dataset.namespace);
                else this.expandedNamespaces.add(button.dataset.namespace);
            }
        } else if (button.dataset.datasetMode) {
            this.combine = button.dataset.datasetMode === "combine";
            this.renderRail();
        } else if (
            button.dataset.browseDataset ||
            ["previous-dataset", "next-dataset"].includes(
                button.dataset.action ?? "",
            )
        ) {
            if (
                (this.combine && this.view !== "overview") ||
                (!button.dataset.browseDataset && this.datasets.length !== 1)
            )
                return;
            const datasets = this.railDatasets();
            const index = datasets.findIndex(
                (item) => item.name === this.dataset.name,
            );
            const dataset = button.dataset.browseDataset
                ? this.availableDatasets.find(
                      (item) => item.name === button.dataset.browseDataset,
                  )
                : datasets[
                      index +
                          (button.dataset.action === "next-dataset" ? 1 : -1)
                  ];
            if (
                !dataset ||
                dataset.error ||
                !dataset.columns.length ||
                (dataset.name === this.dataset.name &&
                    this.datasets.length === 1 &&
                    this.view !== "overview")
            )
                return;
            this.updateDatasets([dataset], true, true);
            if (!button.isConnected || button.disabled) {
                this.host
                    .querySelector<HTMLButtonElement>(
                        '[data-browse-dataset][aria-current="true"]',
                    )
                    ?.focus();
            }
        } else if (button.dataset.valuesRow !== undefined) {
            if (button.hidden) return;
            const index = Number(button.dataset.valuesRow);
            const wasOpen = this.openValueRow === index;
            if (index !== this.selected) this.selectRow(index);
            if (this.profile(this.filters[index])?.success === false) {
                this.openValueRow = index;
                this.element(".quarry-explore-field").hidden = false;
                this.loadValues();
                this.positionValues();
            } else if (wasOpen) this.closeAuxiliaryPanels();
            else this.openValues();
        } else if (button.dataset.action === "format") {
            const open = this.element(".quarry-explore-format-panel").hidden;
            this.closeAuxiliaryPanels();
            this.element(".quarry-explore-format-panel").hidden = !open;
            button.setAttribute("aria-expanded", String(open));
        } else if (button.dataset.action === "choose-datasets") {
            this.chooseDatasets();
        } else if (button.dataset.removeDataset) {
            const datasets = this.datasets.filter(
                (dataset) => dataset.name !== button.dataset.removeDataset,
            );
            if (datasets.length && datasets.length !== this.datasets.length)
                this.updateDatasets(datasets, false);
        } else if (button.dataset.view) {
            this.setView(button.dataset.view);
            if (button.dataset.view === "rows") this.newSample();
        } else if (
            button.dataset.value !== undefined ||
            button.dataset.removeTerm !== undefined
        ) {
            const row = button.closest<HTMLElement>("[data-row]");
            if (row && Number(row.dataset.row) !== this.selected)
                this.selectRow(Number(row.dataset.row));
            const values = this.readValues();
            const value =
                button.dataset.value ?? button.dataset.removeTerm ?? "";
            this.filters[this.selected].value = (
                values.includes(value)
                    ? values.filter((item) => item !== value)
                    : [...values, value]
            ).join(", ");
            this.filters[this.selected].term = "";
            if (this.valueSearch) {
                this.valueSearch = "";
                if (this.searchTimer) clearTimeout(this.searchTimer);
                this.loadValues();
            } else this.renderSuggestions();
            this.renderDraft();
            if (button.dataset.removeTerm !== undefined)
                this.element<HTMLInputElement>(
                    `[data-row="${this.selected}"] .quarry-explore-value`,
                ).focus();
        } else if (button.dataset.action === "add-term") {
            this.commitTerm();
            this.valueSearch = "";
            this.loadValues();
        } else if (button.dataset.remove !== undefined) {
            if (this.filters.length === 1) return;
            const index = Number(button.dataset.remove);
            this.filters.splice(index, 1);
            if (!this.filters.length) this.filters.push(this.blankFilter());
            this.selected = Math.min(index, this.filters.length - 1);
            this.renderFilters();
            this.selectRow(this.selected);
            this.renderDraft();
        } else if (button.dataset.removeOutput !== undefined) {
            this.outputs.splice(Number(button.dataset.removeOutput), 1);
            this.renderOutput();
            this.renderDraft();
        } else if (button.dataset.action === "retry-values") this.loadValues();
        else if (button.dataset.action === "add") {
            const row = this.filters[this.selected] ?? this.blankFilter();
            this.filters.push({ ...row, value: "", term: "" });
            this.selected = this.filters.length - 1;
            this.renderFilters();
            this.selectRow(this.selected);
            this.element<HTMLInputElement>(
                `[data-row="${this.selected}"] .quarry-explore-value`,
            ).focus();
            this.renderDraft();
        } else if (button.dataset.action === "clear-filters") {
            this.filters = [this.blankFilter()];
            this.selected = 0;
            this.closeAuxiliaryPanels();
            this.renderFilters();
            this.selectRow(0);
            this.renderDraft();
            this.element<HTMLInputElement>(".quarry-explore-value").focus();
        } else if (button.dataset.action === "test") this.testQuery();
        else if (
            button.dataset.action === "copy" ||
            button.dataset.action === "use"
        ) {
            const { query, error } = this.promptTag();
            if (error) return;
            if (button.dataset.action === "copy") {
                void this.copy(query, button);
            } else {
                insertQuarryQuery(query);
                this.close();
            }
        } else if (button.classList.contains("quarry-runquery-copy")) {
            void this.copy(
                button
                    .closest("tr")
                    ?.querySelector(".quarry-runquery-prompt-text")
                    ?.textContent ?? "",
                button,
            );
        }
    };
}
