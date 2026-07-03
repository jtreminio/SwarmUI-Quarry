"use strict";
(() => {
  // frontend/util.ts
  var escapeHtml = (text) => {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };
  var formatBytes = (bytes) => {
    if (bytes == null || bytes < 0) {
      return "—";
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1e3 && unit < units.length - 1) {
      value /= 1e3;
      unit++;
    }
    const decimals = unit === 0 || value >= 100 ? 0 : 1;
    return `${value.toFixed(decimals)} ${units[unit]}`;
  };
  var datasetFolder = (name) => {
    const slash = name.lastIndexOf("/");
    return slash > 0 ? name.slice(0, slash) : null;
  };
  var datasetLeafName = (name) => name.slice(name.lastIndexOf("/") + 1);
  var buildFolderTree = (items) => {
    const loose = [];
    const roots = [];
    const byPath = /* @__PURE__ */ new Map();
    const ensureFolder = (path) => {
      const existing = byPath.get(path);
      if (existing) {
        return existing;
      }
      const slash = path.lastIndexOf("/");
      const node = {
        path,
        name: path.slice(slash + 1),
        folders: [],
        items: []
      };
      byPath.set(path, node);
      if (slash > 0) {
        ensureFolder(path.slice(0, slash)).folders.push(node);
      } else {
        roots.push(node);
      }
      return node;
    };
    for (const item of items) {
      const folder = datasetFolder(item.name);
      if (folder === null) {
        loose.push(item);
      } else {
        ensureFolder(folder).items.push(item);
      }
    }
    const sortNode = (node) => {
      node.folders.sort((a, b) => a.name.localeCompare(b.name));
      node.folders.forEach(sortNode);
    };
    roots.sort((a, b) => a.name.localeCompare(b.name));
    roots.forEach(sortNode);
    return { loose, folders: roots };
  };
  var folderDatasetCount = (node) => node.items.length + node.folders.reduce((sum, child) => sum + folderDatasetCount(child), 0);
  var folderPrefixes = (path) => {
    const prefixes = [];
    let acc = "";
    for (const part of path.split("/")) {
      acc = acc ? `${acc}/${part}` : part;
      prefixes.push(acc);
    }
    return prefixes;
  };
  var allAncestorsExpanded = (container, expanded) => !container || folderPrefixes(container).every((p) => expanded.has(p));
  var refreshFolderVisibility = (container, expanded) => {
    for (const row of Array.from(
      container.querySelectorAll("[data-parent]")
    )) {
      row.classList.toggle(
        "quarry-row-hidden",
        !allAncestorsExpanded(row.getAttribute("data-parent"), expanded)
      );
    }
  };

  // frontend/complete.ts
  var datasets = [];
  var setCompletionDatasets = (list) => {
    datasets = (list ?? []).filter((d) => !d.error).map((d) => ({
      name: d.name,
      columns: d.columns ?? [],
      tagColumns: d.configuredTagColumns ?? [],
      promptColumn: d.resolvedPromptColumn,
      rowCount: d.rowCount ?? null
    }));
  };
  var MAX_DATASET_SUGGESTIONS = 50;
  var FILTER_OPERATORS = [
    { op: "=", hint: "match any of the values" },
    { op: "==", hint: "match all of the values" },
    { op: "!=", hint: "match none of the values" },
    { op: "+=", hint: "at least (number columns)", numericOnly: true },
    { op: "-=", hint: "at most (number columns)", numericOnly: true }
  ];
  var findDataset = (list, name) => {
    const low = name.trim().toLowerCase();
    return list.find((d) => d.name.toLowerCase() === low) ?? null;
  };
  var filterByFragment = (items, frag, getName, prefixFirst) => {
    if (frag.length === 0) {
      return items.slice();
    }
    const matched = items.filter(
      (i) => getName(i).toLowerCase().includes(frag)
    );
    if (!prefixFirst) {
      return matched;
    }
    const starts = matched.filter(
      (i) => getName(i).toLowerCase().startsWith(frag)
    );
    const rest = matched.filter(
      (i) => !getName(i).toLowerCase().startsWith(frag)
    );
    return starts.concat(rest);
  };
  var orderColumnsForFilter = (dataset) => {
    const byLower = new Map(
      dataset.columns.map((c) => [c.name.toLowerCase(), c])
    );
    const used = /* @__PURE__ */ new Set();
    const result = [];
    const push = (col, hint) => {
      if (!used.has(col.name.toLowerCase())) {
        used.add(col.name.toLowerCase());
        result.push({
          name: col.name,
          hint,
          numeric: col.numeric ?? false
        });
      }
    };
    for (const tag of dataset.tagColumns) {
      const col = byLower.get(tag.trim().toLowerCase());
      if (col) {
        push(col, "tag column");
      }
    }
    if (result.length === 0 && dataset.promptColumn) {
      const col = byLower.get(dataset.promptColumn.toLowerCase());
      if (col) {
        push(col, "prompt column");
      }
    }
    for (const col of dataset.columns) {
      push(col, col.kind === "list" ? "list column" : "column");
    }
    return result;
  };
  var completeDatasetName = (suffix, list) => {
    const commaIdx = suffix.lastIndexOf(",");
    const frag = suffix.slice(commaIdx + 1).trim().toLowerCase();
    const chosen = new Set(
      suffix.slice(0, commaIdx + 1).split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)
    );
    const candidates = list.filter((d) => !chosen.has(d.name.toLowerCase()));
    const matches = filterByFragment(candidates, frag, (d) => d.name, true);
    if (matches.length === 1 && matches[0].name.toLowerCase() === frag) {
      return [];
    }
    const head = `<q:${suffix.slice(0, commaIdx + 1)}`;
    return matches.slice(0, MAX_DATASET_SUGGESTIONS).map((d) => ({
      apply: head + d.name,
      label: d.name,
      hint: d.rowCount != null ? `${d.rowCount.toLocaleString()} rows` : ""
    }));
  };
  var completeFilterColumn = (suffix, lastOpen, list) => {
    const names = suffix.slice(0, lastOpen).split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (names.length !== 1) {
      return [];
    }
    const dataset = findDataset(list, names[0]);
    if (!dataset) {
      return [];
    }
    const inner = suffix.slice(lastOpen + 1);
    const semiIdx = inner.lastIndexOf(";");
    const clause = semiIdx === -1 ? inner : inner.slice(semiIdx + 1);
    if (/[=!]/.test(clause)) {
      return [];
    }
    const head = `<q:${suffix.slice(0, lastOpen + 1 + (semiIdx === -1 ? 0 : semiIdx + 1))}`;
    const columns = orderColumnsForFilter(dataset);
    const frag = clause.trim().toLowerCase();
    const exact = columns.find((c) => c.name.toLowerCase() === frag);
    if (exact) {
      return FILTER_OPERATORS.filter(
        (o) => !o.numericOnly || exact.numeric
      ).map((o) => ({
        apply: `${head}${exact.name}${o.op}`,
        label: o.op,
        hint: o.hint
      }));
    }
    return filterByFragment(columns, frag, (c) => c.name, false).map((c) => ({
      apply: head + c.name,
      label: c.name,
      hint: c.hint
    }));
  };
  var orderColumnsForPrompt = (named) => {
    const used = /* @__PURE__ */ new Set();
    const result = [];
    const push = (col, hint) => {
      if (!used.has(col.name.toLowerCase())) {
        used.add(col.name.toLowerCase());
        result.push({ name: col.name, hint });
      }
    };
    for (const dataset of named) {
      const col = dataset.promptColumn ? dataset.columns.find(
        (c) => c.name.toLowerCase() === dataset.promptColumn?.toLowerCase()
      ) : void 0;
      if (col) {
        push(col, "default prompt column");
      }
    }
    for (const dataset of named) {
      for (const col of dataset.columns) {
        push(col, col.kind === "list" ? "list column" : "column");
      }
    }
    return result;
  };
  var completePromptColumn = (suffix, colonIdx, list) => {
    const head = suffix.slice(0, colonIdx);
    const bracketIdx = head.indexOf("[");
    const namesPart = bracketIdx === -1 ? head : head.slice(0, bracketIdx);
    const named = namesPart.split(",").map((s) => s.trim()).filter((s) => s.length > 0).map((n) => findDataset(list, n)).filter((d) => d !== null);
    if (named.length === 0) {
      return [];
    }
    const frag = suffix.slice(colonIdx + 1).trim().toLowerCase();
    const matches = filterByFragment(
      orderColumnsForPrompt(named),
      frag,
      (c) => c.name,
      false
    );
    if (matches.length === 1 && matches[0].name.toLowerCase() === frag) {
      return [];
    }
    const applyHead = `<q:${suffix.slice(0, colonIdx + 1)}`;
    return matches.map((c) => ({
      apply: applyHead + c.name,
      label: c.name,
      hint: c.hint
    }));
  };
  var computeQuarryCompletions = (suffix, list = datasets) => {
    const lastOpen = suffix.lastIndexOf("[");
    const lastClose = suffix.lastIndexOf("]");
    if (lastOpen > lastClose) {
      return completeFilterColumn(suffix, lastOpen, list);
    }
    const colonIdx = suffix.indexOf(":", lastClose + 1);
    if (colonIdx !== -1) {
      return completePromptColumn(suffix, colonIdx, list);
    }
    if (lastClose !== -1) {
      return [];
    }
    return completeDatasetName(suffix, list);
  };
  var registered = false;
  var registerQuarryCompletion = () => {
    if (registered) {
      return;
    }
    if (typeof promptTabComplete === "undefined" || !promptTabComplete || typeof promptTabComplete.registerPrefix !== "function") {
      return;
    }
    promptTabComplete.registerPrefix(
      "q",
      "Quarry: a random entry from a dataset (a filterable wildcard) — lists your datasets",
      (suffix) => computeQuarryCompletions(suffix).map((c) => ({
        raw: true,
        name: c.apply,
        clean_html: escapeHtml(c.label),
        desc: c.hint
      }))
    );
    registered = true;
  };

  // frontend/prompt.ts
  var HIGHLIGHT_DEBOUNCE_MS = 250;
  var PROMPT_BOX_IDS = ["alt_prompt_textbox", "alt_negativeprompt_textbox"];
  var Q_TAG_GUARD = /<q(?:\[|:)/i;
  var listeners = [];
  var lastNames = [];
  var onReferences = (listener) => {
    listeners.push(listener);
    listener(lastNames);
  };
  var notify = (names) => {
    lastNames = names;
    for (const listener of listeners) {
      listener(names);
    }
  };
  var readPromptText = () => PROMPT_BOX_IDS.map(
    (id) => document.getElementById(id)?.value ?? ""
  ).join("\n");
  var recomputeReferences = () => {
    const prompt = readPromptText();
    if (!Q_TAG_GUARD.test(prompt)) {
      notify([]);
      return;
    }
    genericRequest(
      "QuarryResolveReferences",
      { prompt },
      (data) => {
        if (data.success) {
          notify(data.names ?? []);
        }
      }
    );
  };
  var highlightTimer = null;
  var schedule = () => {
    if (highlightTimer) {
      clearTimeout(highlightTimer);
    }
    highlightTimer = setTimeout(recomputeReferences, HIGHLIGHT_DEBOUNCE_MS);
  };
  var watching = false;
  var startPromptWatcher = () => {
    if (watching) {
      return;
    }
    watching = true;
    for (const id of PROMPT_BOX_IDS) {
      document.getElementById(id)?.addEventListener("input", schedule);
    }
  };
  var addToExistingTag = true;
  var setAddToExistingTag = (value) => {
    addToExistingTag = value;
  };
  var Q_TAG_PATTERN = "<(q(?:\\[\\d+(?:-\\d+)?\\])?):([^>]*)>";
  var splitTagInner = (inner) => {
    const colon = inner.indexOf(":", inner.lastIndexOf("]") + 1);
    const head = colon < 0 ? inner : inner.slice(0, colon);
    const column = colon < 0 ? "" : inner.slice(colon);
    const bracket = head.indexOf("[");
    const namesPart = bracket < 0 ? head : head.slice(0, bracket);
    const filter = bracket < 0 ? "" : head.slice(bracket);
    const names = namesPart.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
    return { names, filter, column };
  };
  var findQuarryTags = (value) => {
    const regex = new RegExp(Q_TAG_PATTERN, "gi");
    const tags = [];
    let match = regex.exec(value);
    while (match !== null) {
      const { names, filter, column } = splitTagInner(match[2]);
      tags.push({
        start: match.index,
        end: match.index + match[0].length,
        keyword: match[1],
        names,
        filter,
        column
      });
      match = regex.exec(value);
    }
    return tags;
  };
  var buildTag = (tag, names) => `<${tag.keyword}:${names.join(",")}${tag.filter}${tag.column}>`;
  var trimSpacesOnly = (text) => text.replace(/^ +| +$/g, "");
  var removeDatasetFromValue = (value, name) => {
    const lower = name.toLowerCase();
    for (const tag of findQuarryTags(value)) {
      const index = tag.names.findIndex((n) => n.toLowerCase() === lower);
      if (index < 0) {
        continue;
      }
      const remaining = tag.names.filter((_, i) => i !== index);
      if (remaining.length > 0 || tag.filter.length > 0) {
        const rebuilt = buildTag(tag, remaining);
        return {
          value: value.slice(0, tag.start) + rebuilt + value.slice(tag.end),
          cursor: tag.start + rebuilt.length
        };
      }
      const before = value.slice(0, tag.start).replace(/ +$/, "");
      const after = value.slice(tag.end).replace(/^ +/, "");
      const joiner = before.length > 0 && after.length > 0 ? " " : "";
      return { value: before + joiner + after, cursor: before.length };
    }
    return null;
  };
  var addDatasetToFirstTag = (value, name) => {
    const [target] = findQuarryTags(value);
    if (!target) {
      return null;
    }
    const rebuilt = buildTag(target, [...target.names, name]);
    return {
      value: value.slice(0, target.start) + rebuilt + value.slice(target.end),
      cursor: target.start + rebuilt.length
    };
  };
  var insertNewTag = (value, cursorPos, name) => {
    const tag = `<q:${name}>`;
    const prefix = trimSpacesOnly(value.slice(0, cursorPos));
    const suffix = trimSpacesOnly(value.slice(cursorPos));
    if (prefix.length > 0 && suffix.length > 0) {
      return {
        value: `${prefix} ${tag} ${suffix}`,
        cursor: prefix.length + 1 + tag.length
      };
    }
    if (prefix.length > 0) {
      return {
        value: `${prefix} ${tag}`,
        cursor: prefix.length + 1 + tag.length
      };
    }
    if (suffix.length > 0) {
      return { value: `${tag} ${suffix}`, cursor: tag.length };
    }
    return { value: tag, cursor: tag.length };
  };
  var computePromptEdit = (value, cursorPos, name, addToExisting) => {
    const removed = removeDatasetFromValue(value, name);
    if (removed) {
      return removed;
    }
    if (addToExisting) {
      const combined = addDatasetToFirstTag(value, name);
      if (combined) {
        return combined;
      }
    }
    return insertNewTag(value, cursorPos, name);
  };
  var insertQuarryTag = (name) => {
    let [promptBox, cursorPos] = uiImprover.getLastSelectedTextbox();
    if (!promptBox) {
      promptBox = getRequiredElementById(
        "alt_prompt_textbox"
      );
      cursorPos = promptBox.value.length;
    }
    const edit = computePromptEdit(
      promptBox.value,
      cursorPos,
      name,
      addToExistingTag
    );
    promptBox.value = edit.value;
    promptBox.selectionStart = edit.cursor;
    promptBox.selectionEnd = edit.cursor;
    promptBox.focus();
    triggerChangeFor(promptBox);
    recomputeReferences();
  };

  // frontend/searchtab.ts
  var TAB_ID = "ImageSearch-Tab";
  var IMAGE_SEARCH_BODY_ID = "imagesearch-tab-body";
  var registerTabWithLayout = (navLink) => {
    if (typeof genTabLayout === "undefined" || !genTabLayout) {
      return;
    }
    const tab = new MovableGenTab(navLink, genTabLayout);
    genTabLayout.managedTabs.push(tab);
    if (genTabLayout.managedTabContainers.length > 0) {
      tab.contentElem.style.height = "100%";
      tab.contentElem.style.width = "100%";
      if (!genTabLayout.managedTabContainers.includes(
        tab.contentElem.parentElement
      )) {
        genTabLayout.managedTabContainers.push(
          tab.contentElem.parentElement
        );
      }
      tab.update();
      tab.navElem.addEventListener(
        "click",
        () => browserUtil.makeVisible(tab.contentElem)
      );
      genTabLayout.reapplyPositions();
    }
  };
  var injectImageSearchTab = (onFirstShow) => {
    const nav = document.getElementById("bottombartabcollection");
    const content = document.getElementById("t2i_bottom_bar_content");
    if (!nav || !content || document.getElementById(TAB_ID)) {
      return;
    }
    const li = document.createElement("li");
    li.className = "nav-item";
    li.setAttribute("role", "presentation");
    li.innerHTML = `<a class="nav-link translate" data-bs-toggle="tab" href="#${TAB_ID}" id="imagesearchtabbutton" aria-selected="false" tabindex="-1" role="tab">Image Search</a>`;
    const historyNav = nav.querySelector("#imagehistorytabclickable");
    if (historyNav?.parentElement) {
      historyNav.parentElement.insertAdjacentElement("afterend", li);
    } else {
      nav.appendChild(li);
    }
    const pane = document.createElement("div");
    pane.className = "tab-pane genpage-bottom-tab";
    pane.id = TAB_ID;
    pane.setAttribute("role", "tabpanel");
    pane.innerHTML = `<div class="imagesearch-body" id="${IMAGE_SEARCH_BODY_ID}"></div>`;
    content.appendChild(pane);
    const navLink = li.querySelector("a");
    if (navLink) {
      registerTabWithLayout(navLink);
      let initialized = false;
      navLink.addEventListener("click", () => {
        if (!initialized) {
          initialized = true;
          onFirstShow();
        }
      });
    }
  };

  // frontend/search.ts
  var POLL_MS = 800;
  var SEARCH_LIMIT = 2e3;
  var LOAD_MORE_SIZE = 1e3;
  var operatorsForType = (catalog, type) => catalog[type] ?? [];
  var opNeedsValue = (op) => op !== "is_true" && op !== "is_false";
  var buildSearchRequest = (rows) => rows.filter(
    (row) => row.field && row.op && (!opNeedsValue(row.op) || row.value.trim() !== "")
  ).map((row) => ({
    field: row.field,
    op: row.op,
    value: opNeedsValue(row.op) ? row.value : ""
  }));
  var rowToObject = (columns, row) => {
    const obj = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i]] = row[i] ?? "";
    }
    return obj;
  };
  var resultsInfoText = (hasIndex2, shown, total2) => {
    if (!hasIndex2) {
      return "";
    }
    if (total2 === 0) {
      return "No matching images.";
    }
    if (shown < total2) {
      return `Showing ${shown} of ${total2} matches.`;
    }
    return `${total2} match${total2 === 1 ? "" : "es"}.`;
  };
  var loadMoreState = (available2, hasIndex2, shown, total2, pageSize, busy) => {
    const remaining = total2 - shown;
    if (!available2 || !hasIndex2 || remaining <= 0) {
      return { visible: false, disabled: true, label: "" };
    }
    const next = Math.min(pageSize, remaining);
    return {
      visible: true,
      disabled: busy,
      label: busy ? "Loading…" : `Load ${next} more (${remaining} remaining)`
    };
  };
  var coreFields = [];
  var discoveredFields = [];
  var operatorCatalog = {};
  var available = true;
  var hasIndex = false;
  var total = 0;
  var scanPollTimer = null;
  var browser = null;
  var loadedFiles = [];
  var loadMoreBusy = false;
  var searchPending = false;
  var searchGeneration = 0;
  var body = () => document.getElementById(IMAGE_SEARCH_BODY_ID);
  var el = (id) => document.getElementById(id);
  var request = (url, data, onOk, onErr) => {
    genericRequest(
      url,
      data,
      onOk,
      0,
      onErr ? (e) => onErr(typeof e === "string" ? e : "Request failed.") : null
    );
  };
  var fieldOptionsHtml = () => {
    const core = coreFields.map(
      (field) => `<option value="${escapeHtml(field.name)}" data-type="${field.type}">${escapeHtml(field.label)}</option>`
    ).join("");
    const discovered = discoveredFields.map(
      (name) => `<option value="${escapeHtml(name)}" data-type="discovered">${escapeHtml(name)}</option>`
    ).join("");
    const discoveredGroup = discovered ? `<optgroup label="Discovered fields">${discovered}</optgroup>` : "";
    return `<optgroup label="Fields">${core}</optgroup>${discoveredGroup}`;
  };
  var opOptionsHtml = (type) => operatorsForType(operatorCatalog, type).map(
    (op) => `<option value="${escapeHtml(op.value)}">${escapeHtml(op.label)}</option>`
  ).join("");
  var filterRowHtml = () => `<div class="imagesearch-filter-row">
        <select class="imagesearch-field auto-dropdown">${fieldOptionsHtml()}</select>
        <select class="imagesearch-op auto-dropdown">${opOptionsHtml(firstFieldType())}</select>
        <input type="text" class="imagesearch-value auto-text" placeholder="value" autocomplete="off">
        <button type="button" class="basic-button imagesearch-remove" title="Remove this filter">✕</button>
    </div>`;
  var firstFieldType = () => coreFields[0]?.type ?? "text";
  var skeletonHtml = () => `<div class="imagesearch-top">
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
  var readFilters = () => {
    const rows = [];
    for (const row of Array.from(
      document.querySelectorAll(".imagesearch-filter-row")
    )) {
      const field = row.querySelector(".imagesearch-field")?.value ?? "";
      const op = row.querySelector(".imagesearch-op")?.value ?? "";
      const value = row.querySelector(".imagesearch-value")?.value ?? "";
      rows.push({ field, op, value });
    }
    return rows;
  };
  var sortParams = () => {
    const value = el("imagesearch-sort")?.value ?? "date-desc";
    const [sortBy, dir] = value.split("-");
    return { sortBy, sortDescending: dir !== "asc" };
  };
  var basename = (path) => {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(slash + 1) : path;
  };
  var toBrowserFile = (obj) => {
    const path = obj.path ?? "";
    return {
      name: path,
      data: {
        src: `${getImageOutPrefix()}/${path}`,
        fullsrc: path,
        name: basename(path),
        metadata: obj.full_metadata ?? ""
      }
    };
  };
  var listResults = (_folder, _isRefresh, callback, _depth) => {
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
    request(
      "QuarrySearchImageHistory",
      {
        filtersJson: JSON.stringify(filters),
        sortBy,
        sortDescending,
        limit: SEARCH_LIMIT,
        offset: 0
      },
      (data) => {
        searchPending = false;
        available = data.available ?? true;
        hasIndex = data.hasIndex ?? false;
        total = data.total ?? 0;
        const columns = data.columns ?? [];
        loadedFiles = (data.rows ?? []).map(
          (row) => toBrowserFile(rowToObject(columns, row))
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
      }
    );
  };
  var selectResult = (file, div) => {
    selectOutputInHistory(file, div);
    const results = el("imagesearch-results-browser");
    if (!results) {
      return;
    }
    for (const block of Array.from(
      results.getElementsByClassName("image-block")
    )) {
      block.classList.toggle("image-block-current", block === div);
    }
  };
  var ensureBrowser = () => {
    if (browser) {
      return;
    }
    browser = new GenPageBrowserClass(
      "imagesearch-results-browser",
      listResults,
      "quarryimagesearch",
      "Thumbnails",
      describeOutputFile,
      selectResult
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
  var runSearch = () => {
    if (!available) {
      return;
    }
    ensureBrowser();
    browser?.lightRefresh();
    updateLoadMore();
  };
  var appendResults = (newFiles) => {
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
  var loadMore = () => {
    if (!available || searchPending || loadMoreBusy || loadedFiles.length >= total || !browser?.contentDiv) {
      return;
    }
    const gen = searchGeneration;
    loadMoreBusy = true;
    updateLoadMore();
    const { sortBy, sortDescending } = sortParams();
    const filters = buildSearchRequest(readFilters());
    request(
      "QuarrySearchImageHistory",
      {
        filtersJson: JSON.stringify(filters),
        sortBy,
        sortDescending,
        limit: LOAD_MORE_SIZE,
        offset: loadedFiles.length
      },
      (data) => {
        if (gen !== searchGeneration) {
          return;
        }
        loadMoreBusy = false;
        total = data.total ?? total;
        const columns = data.columns ?? [];
        appendResults(
          (data.rows ?? []).map(
            (row) => toBrowserFile(rowToObject(columns, row))
          )
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
      }
    );
  };
  var setNotice = (text, type = "info") => {
    const notice = el("imagesearch-notice");
    if (notice) {
      notice.textContent = text;
      notice.className = text ? `imagesearch-notice imagesearch-notice-${type}` : "imagesearch-notice";
    }
  };
  var applyWarnings = (warnings) => {
    if (warnings.length) {
      setNotice(warnings.join(" "), "warning");
    } else if ((el("imagesearch-notice")?.className ?? "").includes(
      "imagesearch-notice-warning"
    )) {
      setNotice("");
    }
  };
  var updateResultsInfo = () => {
    const info = el("imagesearch-results-info");
    if (info) {
      info.textContent = resultsInfoText(hasIndex, loadedFiles.length, total);
    }
  };
  var updateLoadMore = () => {
    const wrap = el("imagesearch-loadmore");
    const button = el("imagesearch-loadmore-btn");
    if (!wrap || !button) {
      return;
    }
    const state = loadMoreState(
      available,
      hasIndex,
      loadedFiles.length,
      total,
      LOAD_MORE_SIZE,
      loadMoreBusy || searchPending
    );
    wrap.style.display = state.visible ? "" : "none";
    button.disabled = state.disabled;
    if (state.visible) {
      button.textContent = state.label;
    }
  };
  var updateResultsUI = () => {
    updateResultsInfo();
    updateLoadMore();
  };
  var reflectAvailability = () => {
    const controls = el("imagesearch-controls");
    const rescan = el("imagesearch-rescan");
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
        "error"
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
        "info"
      );
    } else if ((el("imagesearch-notice")?.className ?? "").includes(
      "imagesearch-notice-info"
    )) {
      setNotice("");
    }
  };
  var loadFields = (then) => {
    request(
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
      }
    );
  };
  var refreshFieldDropdowns = () => {
    for (const fieldSelect of Array.from(
      document.querySelectorAll(".imagesearch-field")
    )) {
      const previous = fieldSelect.value;
      fieldSelect.innerHTML = fieldOptionsHtml();
      if (Array.from(fieldSelect.options).some((o) => o.value === previous)) {
        fieldSelect.value = previous;
      }
    }
  };
  var addFilterRow = () => {
    const container = el("imagesearch-filters");
    if (!container) {
      return;
    }
    container.insertAdjacentHTML("beforeend", filterRowHtml());
  };
  var ensureOneFilterRow = () => {
    if (!document.querySelector(".imagesearch-filter-row")) {
      addFilterRow();
    }
  };
  var onFieldChanged = (row) => {
    const fieldSelect = row.querySelector(".imagesearch-field");
    const opSelect = row.querySelector(".imagesearch-op");
    const value = row.querySelector(".imagesearch-value");
    if (!fieldSelect || !opSelect) {
      return;
    }
    const selected = fieldSelect.options[fieldSelect.selectedIndex];
    const type = selected?.getAttribute("data-type") ?? "text";
    opSelect.innerHTML = opOptionsHtml(type);
    if (value) {
      value.style.display = opNeedsValue(opSelect.value) ? "" : "none";
    }
  };
  var onOpChanged = (row) => {
    const opSelect = row.querySelector(".imagesearch-op");
    const value = row.querySelector(".imagesearch-value");
    if (opSelect && value) {
      value.style.display = opNeedsValue(opSelect.value) ? "" : "none";
    }
  };
  var setScanUI = (scanning) => {
    const rescan = el("imagesearch-rescan");
    const cancel = el("imagesearch-cancel-scan");
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
  var renderScanStatus = (status) => {
    const bar = el("imagesearch-progress-bar");
    const statusEl = el("imagesearch-status");
    const totalFiles = status.filesTotal ?? 0;
    const done = status.filesDone ?? 0;
    const percent = totalFiles > 0 ? Math.min(100, Math.round(done / totalFiles * 100)) : 0;
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
  var stopScanPolling = () => {
    if (scanPollTimer) {
      clearTimeout(scanPollTimer);
      scanPollTimer = null;
    }
  };
  var pollScanOnce = () => {
    scanPollTimer = null;
    request(
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
      }
    );
  };
  var finishScan = (status) => {
    stopScanPolling();
    setScanUI(false);
    available = status.available ?? available;
    hasIndex = status.hasIndex ?? hasIndex;
    const statusEl = el("imagesearch-status");
    if (status.state === "error") {
      setNotice(
        `Scan failed: ${status.scanError ?? "unknown error"}`,
        "error"
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
  var startRescan = () => {
    setScanUI(true);
    setNotice("");
    const statusEl = el("imagesearch-status");
    if (statusEl) {
      statusEl.textContent = "Starting…";
    }
    request(
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
      }
    );
  };
  var cancelRescan = () => {
    request(
      "QuarryCancelImageHistoryScan",
      {},
      () => {
      },
      () => {
      }
    );
  };
  var resumeScanIfActive = () => {
    request(
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
      () => {
      }
    );
  };
  var wireEvents = () => {
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
      const target = event.target;
      const row = target?.closest(".imagesearch-filter-row");
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
      const target = event.target;
      if (target?.closest(".imagesearch-remove")) {
        target.closest(".imagesearch-filter-row")?.remove();
        ensureOneFilterRow();
      }
    });
    el("imagesearch-filters")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runSearch();
      }
    });
  };
  var initImageSearch = () => {
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

  // frontend/download.ts
  var MODAL_ID = "quarry-download-modal";
  var BODY_ID = "quarry-download-body";
  var MESSAGE_ID = "quarry-download-message";
  var PROGRESS_ID = "quarry-download-progress";
  var START_ID = "quarry-download-start";
  var REFRESH_ID = "quarry-download-refresh";
  var POLL_MS2 = 800;
  var sourceRepoUrl = (name) => {
    const top = name.split("/")[0];
    if (top.length === 0) {
      return null;
    }
    const dot = top.indexOf(".");
    if (dot < 0) {
      return `https://huggingface.co/${top}`;
    }
    if (dot === 0 || dot >= top.length - 1) {
      return null;
    }
    return `https://huggingface.co/datasets/${top.slice(0, dot)}/${top.slice(dot + 1)}`;
  };
  var renderRemoteDatasetName = (name, displayName = name) => {
    const label = escapeHtml(displayName);
    const url = sourceRepoUrl(name);
    if (!url) {
      return label;
    }
    return `<a class="quarry-remote-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener" title="Open ${escapeHtml(name)} on HuggingFace">${label}</a>`;
  };
  var renderRemoteDatasetRow = (dataset, displayName = dataset.name, depth = 0, container = null, hidden = false) => {
    const name = escapeHtml(dataset.name);
    const installed = dataset.installed;
    const rowClass = installed ? "quarry-remote-row quarry-remote-installed" : "quarry-remote-row";
    const hiddenClass = hidden ? " quarry-row-hidden" : "";
    const parentAttr = container ? ` data-parent="${escapeHtml(container)}"` : "";
    const check = installed ? `<span class="quarry-remote-check" title="Installed">✓</span> ` : "";
    const title = installed ? "Already installed — select to redownload" : "Select to download";
    return `<tr class="${rowClass}${hiddenClass}" data-dataset="${name}"${parentAttr} style="--quarry-depth: ${depth}">
        <td class="quarry-remote-selcell">
            <input type="checkbox" class="quarry-remote-select" data-dataset="${name}" data-installed="${installed}" title="${title}" />
        </td>
        <td class="quarry-remote-name">${check}${renderRemoteDatasetName(dataset.name, displayName)}</td>
        <td class="quarry-remote-size">${formatBytes(dataset.sizeBytes)}</td>
    </tr>`;
  };
  var renderRemoteFolderHeaderRow = (node, depth, expanded) => {
    const path = escapeHtml(node.path);
    const collapsed = !expanded.has(node.path);
    const container = datasetFolder(node.path);
    const count = folderDatasetCount(node);
    const hiddenClass = allAncestorsExpanded(container, expanded) ? "" : " quarry-row-hidden";
    const collapsedClass = collapsed ? " quarry-collapsed" : "";
    const parentAttr = container ? ` data-parent="${escapeHtml(container)}"` : "";
    return `<tr class="quarry-folder-row${collapsedClass}${hiddenClass}" data-folder="${path}"${parentAttr} style="--quarry-depth: ${depth}">
        <td colspan="3">
            <button type="button" class="quarry-folder-toggle" data-folder="${path}" aria-expanded="${!collapsed}" title="Show or hide the datasets in this folder">
                <span class="quarry-folder-caret" aria-hidden="true"></span>
                <span class="quarry-folder-name">${escapeHtml(node.name)}</span>
                <span class="quarry-folder-count" title="${count} dataset(s)">${count}</span>
            </button>
        </td>
    </tr>`;
  };
  var renderRemoteFolderNode = (node, depth, expanded) => {
    const childrenHidden = !allAncestorsExpanded(node.path, expanded);
    const subFolders = node.folders.map((child) => renderRemoteFolderNode(child, depth + 1, expanded)).join("");
    const items = node.items.map(
      (dataset) => renderRemoteDatasetRow(
        dataset,
        datasetLeafName(dataset.name),
        depth + 1,
        node.path,
        childrenHidden
      )
    ).join("");
    return renderRemoteFolderHeaderRow(node, depth, expanded) + subFolders + items;
  };
  var renderRemoteDatasets = (list, expandedFolders3 = /* @__PURE__ */ new Set()) => {
    if (!list || list.length === 0) {
      return `<div class="quarry-remote-empty">No datasets available right now.</div>`;
    }
    const { loose, folders } = buildFolderTree(list);
    const folderRows = folders.map((folder) => renderRemoteFolderNode(folder, 0, expandedFolders3)).join("");
    const looseRows = loose.map((dataset) => renderRemoteDatasetRow(dataset)).join("");
    return `<table class="quarry-remote-table">
        <thead><tr>
            <th class="quarry-remote-selcell"><input type="checkbox" class="quarry-remote-selectall" title="Select all" /></th>
            <th>Dataset</th>
            <th>Size</th>
        </tr></thead>
        <tbody>${folderRows}${looseRows}</tbody>
    </table>`;
  };
  var progressPercent = (status) => {
    const total2 = status.bytesTotal ?? 0;
    const done = status.bytesDone ?? 0;
    if (total2 <= 0) {
      return 0;
    }
    return Math.min(100, Math.max(0, Math.round(done / total2 * 100)));
  };
  var renderProgressInfo = (status) => {
    if (status.state === "starting") {
      return "Starting…";
    }
    if (status.state === "finalizing") {
      return "Finalizing…";
    }
    const parts = [
      `${progressPercent(status)}%`,
      `${formatBytes(status.bytesDone ?? 0)} / ${formatBytes(status.bytesTotal ?? 0)}`
    ];
    if ((status.perSecond ?? 0) > 0) {
      parts.push(`${formatBytes(status.perSecond)}/s`);
    }
    if ((status.filesTotal ?? 0) > 0) {
      parts.push(`file ${status.filesDone ?? 0}/${status.filesTotal}`);
    }
    return parts.join(" · ");
  };
  var onChanged = null;
  var currentList = [];
  var tokenSet = false;
  var repoUrl = "";
  var expandedFolders = /* @__PURE__ */ new Set();
  var queue = [];
  var queueIndex = 0;
  var queueTotal = 0;
  var completedCount = 0;
  var failedNames = [];
  var cancelledBatch = false;
  var downloadingName = null;
  var lastRunId = 0;
  var pollTimer = null;
  var renderNote = () => {
    const repo = repoUrl ? `<a href="${escapeHtml(repoUrl)}" target="_blank" rel="noreferrer noopener">the official collection</a>` : "the official collection";
    const tokenHint = tokenSet ? "" : ` <span class="quarry-download-tokenhint">No HuggingFace token set — this public collection still downloads fine; set a token under the User tab for authenticated downloads.</span>`;
    return `<div class="quarry-download-note">${currentList.length} dataset(s) from ${repo}. Tick one or more and click Download.${tokenHint}</div>`;
  };
  var renderList = () => {
    const body2 = document.getElementById(BODY_ID);
    if (body2) {
      body2.innerHTML = renderNote() + renderRemoteDatasets(currentList, expandedFolders);
    }
    updateSelectAllState();
    updateStartButtonState();
  };
  var showMessage = (text, type = "info") => {
    const el2 = document.getElementById(MESSAGE_ID);
    if (!el2) {
      return;
    }
    el2.textContent = text;
    el2.className = text ? `quarry-download-message quarry-download-message-${type}` : "quarry-download-message";
  };
  var rowCheckboxes = () => {
    const body2 = document.getElementById(BODY_ID);
    return body2 ? Array.from(
      body2.querySelectorAll(".quarry-remote-select")
    ) : [];
  };
  var selectAllCheckbox = () => document.getElementById(BODY_ID)?.querySelector(".quarry-remote-selectall") ?? null;
  var selectedDatasets = () => rowCheckboxes().filter((cb) => cb.checked).map((cb) => ({
    name: cb.getAttribute("data-dataset") ?? "",
    redownload: cb.getAttribute("data-installed") === "true"
  })).filter((item) => item.name !== "");
  var updateStartButtonState = () => {
    const start = document.getElementById(START_ID);
    if (start) {
      start.disabled = downloadingName !== null || selectedDatasets().length === 0;
    }
  };
  var updateSelectAllState = () => {
    const all = selectAllCheckbox();
    if (!all) {
      return;
    }
    const boxes = rowCheckboxes();
    const checked = boxes.filter((cb) => cb.checked).length;
    all.checked = boxes.length > 0 && checked === boxes.length;
    all.indeterminate = checked > 0 && checked < boxes.length;
  };
  var setControlsDownloading = (downloading) => {
    const body2 = document.getElementById(BODY_ID);
    if (body2) {
      for (const cb of Array.from(
        body2.querySelectorAll(
          ".quarry-remote-select, .quarry-remote-selectall"
        )
      )) {
        cb.disabled = downloading;
      }
    }
    const refresh2 = document.getElementById(
      REFRESH_ID
    );
    if (refresh2) {
      refresh2.disabled = downloading;
    }
    if (downloading) {
      const start = document.getElementById(
        START_ID
      );
      if (start) {
        start.disabled = true;
      }
    } else {
      updateStartButtonState();
    }
  };
  var highlightActiveRow = (name) => {
    const body2 = document.getElementById(BODY_ID);
    if (!body2) {
      return;
    }
    for (const row of Array.from(
      body2.querySelectorAll("tr.quarry-remote-row")
    )) {
      row.classList.toggle(
        "quarry-remote-downloading",
        name !== null && row.getAttribute("data-dataset") === name
      );
    }
  };
  var progressLabel = () => {
    const name = escapeHtml(downloadingName ?? "");
    const counter = queueTotal > 1 ? `${queueIndex + 1} of ${queueTotal} · ` : "";
    return `Downloading ${counter}${name}`;
  };
  var showBatchProgress = (status) => {
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
  var updateBatchProgress = (status) => {
    const panel = document.getElementById(PROGRESS_ID);
    if (!panel) {
      return;
    }
    if (!panel.querySelector(".quarry-dl-bar")) {
      showBatchProgress(status);
      return;
    }
    const bar = panel.querySelector(".quarry-dl-bar");
    const info = panel.querySelector(".quarry-dl-info");
    const label = panel.querySelector(".quarry-dl-label");
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
  var hideBatchProgress = () => {
    const panel = document.getElementById(PROGRESS_ID);
    if (panel) {
      panel.style.display = "none";
      panel.innerHTML = "";
    }
  };
  var stopPolling = () => {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };
  var scheduleNextPoll = () => {
    pollTimer = setTimeout(pollOnce, POLL_MS2);
  };
  var pollOnce = () => {
    pollTimer = null;
    genericRequest(
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
      }
    );
  };
  var startPolling = () => {
    if (!pollTimer) {
      pollOnce();
    }
  };
  var onItemFinished = (status) => {
    stopPolling();
    const name = downloadingName;
    downloadingName = null;
    lastRunId = 0;
    if (status.state === "done") {
      const entry = currentList.find((d) => d.name === name);
      if (entry) {
        entry.installed = true;
      }
      completedCount++;
    } else if (status.state === "error") {
      failedNames.push(
        `${name ?? "dataset"} (${status.error ?? "unknown error"})`
      );
    } else if (status.state === "cancelled") {
      cancelledBatch = true;
    }
    queueIndex++;
    startNext();
  };
  var startNext = () => {
    if (cancelledBatch || queueIndex >= queue.length) {
      finishBatch();
      return;
    }
    const item = queue[queueIndex];
    highlightActiveRow(item.name);
    showBatchProgress({ success: true, state: "starting" });
    genericRequest(
      "QuarryDownloadDataset",
      { dataset: item.name, redownload: item.redownload },
      (data) => {
        if (!data.success) {
          failedNames.push(
            `${item.name} (${data.error ?? "could not start"})`
          );
          queueIndex++;
          startNext();
          return;
        }
        downloadingName = item.name;
        lastRunId = data.id ?? 0;
        startPolling();
      }
    );
  };
  var finishBatch = () => {
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
        "info"
      );
    } else if (failedNames.length > 0) {
      showMessage(
        `Downloaded ${completedCount} of ${queueTotal}. Failed: ${failedNames.join(", ")}.`,
        "error"
      );
    } else {
      showMessage(
        `Downloaded ${completedCount} dataset${completedCount === 1 ? "" : "s"}.`,
        "success"
      );
    }
    if (completedCount > 0) {
      onChanged?.();
    }
  };
  var startBatch = () => {
    if (downloadingName) {
      return;
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
  var cancelDownload = () => {
    showMessage("Cancelling…", "info");
    cancelledBatch = true;
    genericRequest("QuarryCancelDownload", {}, () => {
    });
  };
  var resumeIfActive = () => {
    genericRequest(
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
      }
    );
  };
  var loadAvailable = (force = false) => {
    const body2 = document.getElementById(BODY_ID);
    if (body2) {
      body2.innerHTML = `<div class="quarry-download-loading">Loading…</div>`;
    }
    genericRequest(
      "QuarryListAvailableDatasets",
      { refresh: force },
      (data) => {
        if (!data.success) {
          if (body2) {
            body2.innerHTML = `<div class="quarry-download-error">${escapeHtml(data.error ?? "Failed to load the dataset list.")}</div>`;
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
      }
    );
  };
  var bodyChangeHandler = (event) => {
    const target = event.target;
    if (target?.classList.contains("quarry-remote-selectall")) {
      const checked = target.checked;
      for (const cb of rowCheckboxes()) {
        cb.checked = checked;
      }
    }
    if (target?.classList.contains("quarry-remote-select") || target?.classList.contains("quarry-remote-selectall")) {
      updateSelectAllState();
      updateStartButtonState();
    }
  };
  var progressClickHandler = (event) => {
    const target = event.target;
    if (target?.closest(".quarry-remote-cancel")) {
      cancelDownload();
    }
  };
  var toggleFolder = (toggle) => {
    const folder = toggle.getAttribute("data-folder");
    const row = toggle.closest(".quarry-folder-row");
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
    const body2 = document.getElementById(BODY_ID);
    if (body2) {
      refreshFolderVisibility(body2, expandedFolders);
    }
  };
  var bodyClickHandler = (event) => {
    const target = event.target;
    const folderToggle = target?.closest(".quarry-folder-toggle");
    if (folderToggle) {
      toggleFolder(folderToggle);
    }
  };
  var ensureDownloadModal = () => {
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
                </div>
                <div class="modal-footer quarry-download-footer">
                    <div class="quarry-download-footer-actions">
                        <button type="button" id="${START_ID}" class="btn btn-primary basic-button" disabled>Download</button>
                        <button type="button" id="${REFRESH_ID}" class="btn btn-secondary basic-button">Refresh</button>
                    </div>
                    <button type="button" class="btn btn-secondary basic-button" data-bs-dismiss="modal">Close</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.querySelector('[data-bs-dismiss="modal"]')?.addEventListener("click", hideDownloadModal);
    document.getElementById(START_ID)?.addEventListener("click", startBatch);
    document.getElementById(REFRESH_ID)?.addEventListener("click", () => loadAvailable(true));
    document.getElementById(BODY_ID)?.addEventListener("change", bodyChangeHandler);
    document.getElementById(BODY_ID)?.addEventListener("click", bodyClickHandler);
    document.getElementById(PROGRESS_ID)?.addEventListener("click", progressClickHandler);
  };
  var showDownloadModal = () => {
    if (typeof $ === "function") {
      $(`#${MODAL_ID}`).modal("show");
    }
  };
  var hideDownloadModal = () => {
    if (typeof $ === "function") {
      $(`#${MODAL_ID}`).modal("hide");
    }
  };
  var openDownloadModal = (onChangedCb) => {
    onChanged = onChangedCb;
    ensureDownloadModal();
    showDownloadModal();
    loadAvailable();
  };

  // frontend/tab.ts
  var TAB_ID2 = "Quarry-Tab";
  var QUARRY_TAB_BODY_ID = "quarry-tab-body";
  var registerTabWithLayout2 = (navLink) => {
    if (typeof genTabLayout === "undefined" || !genTabLayout) {
      return;
    }
    const tab = new MovableGenTab(navLink, genTabLayout);
    genTabLayout.managedTabs.push(tab);
    if (genTabLayout.managedTabContainers.length > 0) {
      tab.contentElem.style.height = "100%";
      tab.contentElem.style.width = "100%";
      if (!genTabLayout.managedTabContainers.includes(
        tab.contentElem.parentElement
      )) {
        genTabLayout.managedTabContainers.push(
          tab.contentElem.parentElement
        );
      }
      tab.update();
      tab.navElem.addEventListener(
        "click",
        () => browserUtil.makeVisible(tab.contentElem)
      );
      genTabLayout.reapplyPositions();
    }
  };
  var injectQuarryTab = () => {
    const nav = document.getElementById("bottombartabcollection");
    const content = document.getElementById("t2i_bottom_bar_content");
    if (!nav || !content || document.getElementById(TAB_ID2)) {
      return;
    }
    const li = document.createElement("li");
    li.className = "nav-item";
    li.setAttribute("role", "presentation");
    li.innerHTML = `<a class="nav-link translate" data-bs-toggle="tab" href="#${TAB_ID2}" aria-selected="false" tabindex="-1" role="tab">Quarry</a>`;
    const toolsNav = nav.querySelector('a[href="#Tools-Tab"]');
    if (toolsNav?.parentElement) {
      nav.insertBefore(li, toolsNav.parentElement);
    } else {
      nav.appendChild(li);
    }
    const pane = document.createElement("div");
    pane.className = "tab-pane genpage-bottom-tab";
    pane.id = TAB_ID2;
    pane.setAttribute("role", "tabpanel");
    pane.innerHTML = `<div class="quarry-tab-body" id="${QUARRY_TAB_BODY_ID}"></div>`;
    content.appendChild(pane);
    const navLink = li.querySelector("a");
    if (navLink) {
      registerTabWithLayout2(navLink);
    }
  };

  // frontend/settings.ts
  var MESSAGE_TIMEOUT_MS = 5e3;
  var PREVIEW_ROW_LIMIT = 100;
  var PREVIEW_LOAD_MORE_COUNT = 500;
  var ADD_TO_EXISTING_TAG_ID = "quarry-add-to-existing-tag";
  var PREVIEW_MODAL_ID = "quarry-preview-modal";
  var PREVIEW_TITLE_ID = "quarry-preview-title";
  var PREVIEW_BODY_ID = "quarry-preview-body";
  var PREVIEW_STATUS_ID = "quarry-preview-status";
  var PREVIEW_LOAD_MORE_ID = "quarry-preview-loadmore";
  var PREVIEW_CLEAR_ID = "quarry-preview-clear";
  var expandedFolders2 = /* @__PURE__ */ new Set();
  var renderDatasetOptions = (dataset) => dataset.columns.map((col) => {
    const selected = col.name === dataset.resolvedPromptColumn ? " selected" : "";
    const badge = col.kind === "list" ? " [list]" : "";
    return `<option value="${escapeHtml(col.name)}"${selected}>${escapeHtml(col.name)}${badge}</option>`;
  }).join("");
  var renderTagCheckboxes = (dataset) => dataset.columns.map((col) => {
    const checked = (dataset.configuredTagColumns ?? []).includes(
      col.name
    ) ? " checked" : "";
    const badge = col.kind === "list" ? " [list]" : "";
    return `<label class="quarry-tag-option"><input type="checkbox" class="quarry-dataset-tag" data-dataset="${escapeHtml(dataset.name)}" value="${escapeHtml(col.name)}"${checked}> ${escapeHtml(col.name)}${badge}</label>`;
  }).join("");
  var formatRowCount = (count) => count == null ? "—" : count.toLocaleString();
  var SUMMARY_ID = "quarry-datasets-summary";
  var formatDatasetsSummary = (datasets2) => {
    const total2 = datasets2.length;
    let rows = 0;
    let counted = 0;
    let size = 0;
    for (const dataset of datasets2) {
      if (dataset.rowCount != null) {
        rows += dataset.rowCount;
        counted += 1;
      }
      if (dataset.sizeBytes != null) {
        size += dataset.sizeBytes;
      }
    }
    const uncounted = total2 - counted;
    const datasetsLabel = `${total2.toLocaleString()} dataset${total2 === 1 ? "" : "s"}`;
    const rowsLabel = uncounted > 0 ? `${rows.toLocaleString()}+ rows (${uncounted.toLocaleString()} not counted yet)` : `${rows.toLocaleString()} rows`;
    return `${datasetsLabel} · ${rowsLabel} · ${formatBytes(size)}`;
  };
  var applyInPromptHighlights = (container, names) => {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    container.querySelectorAll("tr.quarry-dataset-row").forEach((row) => {
      const name = (row.getAttribute("data-dataset") ?? "").toLowerCase();
      row.classList.toggle("quarry-dataset-in-prompt", wanted.has(name));
    });
  };
  var renderDatasetNameButton = (name, label = name) => `<button type="button" class="quarry-dataset-name quarry-dataset-name-link" data-dataset="${name}" title="Add a reference to this dataset to your prompt">${label}</button>`;
  var ENABLE_TITLE = "Enabled — included when a <q:> wildcard (like **) matches it. Click to disable.";
  var DISABLE_TITLE = "Disabled — skipped by <q:> wildcards, but still used when a prompt names it explicitly. Click to enable.";
  var isDatasetEnabled = (dataset) => dataset.enabled !== false;
  var renderEnableToggle = (name, enabled) => {
    const stateCls = enabled ? "quarry-enabled" : "quarry-disabled";
    const title = enabled ? ENABLE_TITLE : DISABLE_TITLE;
    return `<button type="button" class="quarry-dataset-enable ${stateCls}" role="switch" aria-checked="${enabled}" data-dataset="${escapeHtml(name)}" title="${escapeHtml(title)}"><span class="quarry-enable-knob" aria-hidden="true"></span></button>`;
  };
  var renderDatasetRow = (dataset, displayName = dataset.name, depth = 0, container = null, hidden = false) => {
    const name = escapeHtml(dataset.name);
    const label = escapeHtml(displayName);
    const enabled = isDatasetEnabled(dataset);
    const cls = `quarry-dataset-row${hidden ? " quarry-row-hidden" : ""}${enabled ? "" : " quarry-dataset-disabled"}`;
    const toggleCell = `<td class="quarry-dataset-enable-cell">${renderEnableToggle(dataset.name, enabled)}</td>`;
    const parentAttr = container ? ` data-parent="${escapeHtml(container)}"` : "";
    const attrs = `${parentAttr} style="--quarry-depth: ${depth}"`;
    if (dataset.error) {
      return `<tr class="${cls} quarry-dataset-error" data-dataset="${name}"${attrs}>
            ${toggleCell}
            <td class="quarry-dataset-name-cell">${renderDatasetNameButton(name, label)}</td>
            <td colspan="4"><span class="quarry-dataset-error-msg">⚠️ ${escapeHtml(dataset.error)}</span></td>
        </tr>`;
    }
    return `<tr class="${cls}" data-dataset="${name}"${attrs}>
        ${toggleCell}
        <td class="quarry-dataset-name-cell">${renderDatasetNameButton(name, label)}</td>
        <td><select class="quarry-dataset-column" data-dataset="${name}">${renderDatasetOptions(dataset)}</select></td>
        <td class="quarry-dataset-tags" title="Columns the 'tags' keyword searches across">${renderTagCheckboxes(dataset)}</td>
        <td class="quarry-dataset-rows" data-dataset="${name}" title="Rows in the dataset (loads when you preview it if not already counted)">${formatRowCount(dataset.rowCount)}</td>
        <td><button type="button" class="basic-button quarry-preview-button" data-dataset="${name}" title="Preview this dataset's rows (load more in the dialog)">Preview</button></td>
    </tr>`;
  };
  var renderFolderHeaderRow = (node, depth, expanded) => {
    const path = escapeHtml(node.path);
    const collapsed = !expanded.has(node.path);
    const container = datasetFolder(node.path);
    const count = folderDatasetCount(node);
    const hiddenClass = allAncestorsExpanded(container, expanded) ? "" : " quarry-row-hidden";
    const collapsedClass = collapsed ? " quarry-collapsed" : "";
    const parentAttr = container ? ` data-parent="${escapeHtml(container)}"` : "";
    return `<tr class="quarry-folder-row${collapsedClass}${hiddenClass}" data-folder="${path}"${parentAttr} style="--quarry-depth: ${depth}">
        <td colspan="6">
            <button type="button" class="quarry-folder-toggle" data-folder="${path}" aria-expanded="${!collapsed}" title="Show or hide the datasets in this folder">
                <span class="quarry-folder-caret" aria-hidden="true"></span>
                <span class="quarry-folder-name">${escapeHtml(node.name)}</span>
                <span class="quarry-folder-count" title="${count} dataset(s)">${count}</span>
            </button>
        </td>
    </tr>`;
  };
  var renderFolderNode = (node, depth, expanded) => {
    const childrenHidden = !allAncestorsExpanded(node.path, expanded);
    const subFolders = node.folders.map((child) => renderFolderNode(child, depth + 1, expanded)).join("");
    const items = node.items.map(
      (dataset) => renderDatasetRow(
        dataset,
        datasetLeafName(dataset.name),
        depth + 1,
        node.path,
        childrenHidden
      )
    ).join("");
    return renderFolderHeaderRow(node, depth, expanded) + subFolders + items;
  };
  var renderDatasets = (datasets2, expandedFolders3 = /* @__PURE__ */ new Set()) => {
    if (!datasets2 || datasets2.length === 0) {
      return `<div class="quarry-datasets-empty">No datasets found. Set a folder containing CSV / JSON / JSONL / Parquet / Lance files, then Refresh.</div>`;
    }
    const { loose, folders } = buildFolderTree(datasets2);
    const folderRows = folders.map((folder) => renderFolderNode(folder, 0, expandedFolders3)).join("");
    const looseRows = loose.map((dataset) => renderDatasetRow(dataset)).join("");
    return `<table class="quarry-datasets-table">
        <thead>
            <tr><th class="quarry-enable-th" title="Enable or disable this dataset for &lt;q:&gt; wildcard matches">On</th><th>Dataset</th><th>Prompt column</th><th>Tag columns</th><th>Rows</th><th>Preview</th></tr>
        </thead>
        <tbody>${folderRows}${looseRows}</tbody>
        <tfoot>
            <tr class="quarry-datasets-summary-row">
                <td colspan="6"><span id="${SUMMARY_ID}" class="quarry-datasets-summary" title="Totals across all datasets. Uncounted rows fill in as datasets are warmed or previewed.">${escapeHtml(formatDatasetsSummary(datasets2))}</span></td>
            </tr>
        </tfoot>
    </table>`;
  };
  var renderPreviewTable = (columns, rows) => {
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
    const body2 = rows.map((row) => {
      const cells = columns.map((_, i) => `<td>${escapeHtml(row[i] ?? "")}</td>`).join("");
      return `<tr>${cells}</tr>`;
    }).join("");
    return `<table class="quarry-preview-table simple-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${body2}</tbody>
    </table>`;
  };
  var renderPreviewStatus = (shown, total2) => total2 == null ? `Showing ${shown.toLocaleString()} row(s).` : `Showing ${shown.toLocaleString()} of ${total2.toLocaleString()} row(s).`;
  var renderForm = (folder) => `
    <div class="quarry-settings">
        <form id="quarry-form">
            <div class="input-group input-group-open">
                <span class="input-group-header input-group-noshrink">
                    <span class="header-label-wrap"><span class="header-label">🦆 Quarry</span></span>
                </span>
                <div class="input-group-content">
                    <div class="quarry-actions">
                        <button type="button" id="quarry-refresh" class="basic-button">Refresh</button>
                        <button type="button" id="quarry-download-datasets" class="basic-button" title="Browse and download ready-made datasets from the official collection">Download Datasets</button>
                    </div>
                    <div id="quarry-datasets" class="quarry-datasets"></div>
                    <div class="auto-input auto-input-flex">
                        <label for="quarry-folder"><span class="auto-input-name">Datasets folder</span></label>
                        <input class="auto-text" type="text" id="quarry-folder" value="${escapeHtml(folder)}" placeholder="/path/to/datasets" autocomplete="off">
                    </div>
                    <div class="quarry-setting-row">
                        <span class="auto-input-qbutton info-popover-button" onclick="doPopover('${ADD_TO_EXISTING_TAG_ID}', arguments[0])">?</span>
                        <label for="${ADD_TO_EXISTING_TAG_ID}">Add to existing <code>&lt;q:&gt;</code> tag</label>
                        <input type="checkbox" id="${ADD_TO_EXISTING_TAG_ID}" checked>
                        <div class="sui-popover sui-info-popover" id="popover_${ADD_TO_EXISTING_TAG_ID}"><b>Add to existing &lt;q:&gt; tag</b><br>On by default. When on, clicking a dataset name adds it to the first existing <code>&lt;q:…&gt;</code> tag (e.g. <code>&lt;q:A,B&gt;</code>) instead of inserting a separate one.</div>
                    </div>
                </div>
            </div>
            <div id="quarry-message" class="quarry-message"></div>
            <div class="quarry-actions">
                <button type="submit" class="basic-button">Save Settings</button>
                <button type="button" id="quarry-clean-temp" class="basic-button" title="Delete leftover placeholder .txt files an older Quarry version wrote into SwarmUI's Wildcards folder">Clean temp files</button>
            </div>
        </form>
    </div>`;
  var renderInstallGate = () => `
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
  var collectPromptColumns = (container) => {
    const result = {};
    const selects = container.querySelectorAll(
      "select.quarry-dataset-column"
    );
    selects.forEach((select) => {
      const name = select.getAttribute("data-dataset");
      if (name) {
        result[name] = select.value;
      }
    });
    return result;
  };
  var collectTagColumns = (container) => {
    const result = {};
    const boxes = container.querySelectorAll(
      "input.quarry-dataset-tag"
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
  var collectDisabledDatasets = (container) => {
    const result = [];
    container.querySelectorAll("button.quarry-dataset-enable").forEach((button) => {
      const name = button.getAttribute("data-dataset");
      if (name && button.getAttribute("aria-checked") === "false") {
        result.push(name);
      }
    });
    return result;
  };
  var messageTimer = null;
  var applyTableHighlights = (names) => {
    const container = document.getElementById("quarry-datasets");
    if (container) {
      applyInPromptHighlights(container, names);
    }
  };
  var currentDatasets = [];
  var updateDatasetsSummary = () => {
    const el2 = document.getElementById(SUMMARY_ID);
    if (el2) {
      el2.textContent = formatDatasetsSummary(currentDatasets);
    }
  };
  var applyResponse = (data) => {
    currentDatasets = data.datasets ?? [];
    const folderEl = document.getElementById(
      "quarry-folder"
    );
    if (folderEl) {
      folderEl.value = data.datasetsFolder ?? "";
    }
    const addToExisting = data.addToExistingTag ?? true;
    const addToExistingEl = document.getElementById(
      ADD_TO_EXISTING_TAG_ID
    );
    if (addToExistingEl) {
      addToExistingEl.checked = addToExisting;
    }
    setAddToExistingTag(addToExisting);
    setCompletionDatasets(data.datasets);
    const datasetsEl = document.getElementById("quarry-datasets");
    if (datasetsEl) {
      datasetsEl.innerHTML = renderDatasets(
        data.datasets ?? [],
        expandedFolders2
      );
      recomputeReferences();
    }
  };
  var showMessage2 = (message, type) => {
    const el2 = document.getElementById("quarry-message");
    if (!el2) {
      return;
    }
    el2.textContent = message;
    el2.className = `quarry-message quarry-message-${type}`;
    if (messageTimer) {
      clearTimeout(messageTimer);
    }
    messageTimer = setTimeout(() => {
      el2.textContent = "";
      el2.className = "quarry-message";
      messageTimer = null;
    }, MESSAGE_TIMEOUT_MS);
  };
  var loadSettings = () => {
    genericRequest("QuarryGetSettings", {}, (data) => {
      if (!data.success) {
        return;
      }
      if (data.requirementsInstalled === false) {
        showInstallGate();
        return;
      }
      ensureFormRendered();
      applyResponse(data);
    });
  };
  var saveSettings = () => {
    const folder = document.getElementById("quarry-folder").value.trim();
    const container = document.getElementById("quarry-datasets");
    const promptColumns = container ? collectPromptColumns(container) : {};
    const tagColumns = container ? collectTagColumns(container) : {};
    const disabledDatasets = container ? collectDisabledDatasets(container) : [];
    const addToExistingEl = document.getElementById(
      ADD_TO_EXISTING_TAG_ID
    );
    genericRequest(
      "QuarrySaveSettings",
      {
        datasetsFolder: folder,
        promptColumnsJson: JSON.stringify(promptColumns),
        tagColumnsJson: JSON.stringify(tagColumns),
        disabledDatasetsJson: JSON.stringify(disabledDatasets),
        addToExistingTag: addToExistingEl?.checked ?? true
      },
      (data) => {
        if (data.success) {
          applyResponse(data);
          showMessage2("Settings saved.", "success");
        } else {
          showMessage2(
            `Failed to save: ${data.error ?? "unknown error"}`,
            "error"
          );
        }
      }
    );
  };
  var refresh = () => {
    const button = document.getElementById(
      "quarry-refresh"
    );
    if (button) {
      button.disabled = true;
    }
    genericRequest("QuarryRefresh", {}, (data) => {
      if (button) {
        button.disabled = false;
      }
      if (data.success) {
        applyResponse(data);
        showMessage2(data.message ?? "Refreshed.", "success");
      } else {
        showMessage2(
          `Refresh failed: ${data.error ?? "unknown error"}`,
          "error"
        );
      }
    });
  };
  var cleanTempFiles = () => {
    const button = document.getElementById(
      "quarry-clean-temp"
    );
    if (button) {
      button.disabled = true;
    }
    genericRequest("QuarryCleanTempFiles", {}, (data) => {
      if (button) {
        button.disabled = false;
      }
      if (!data.success) {
        showMessage2(
          `Clean failed: ${data.error ?? "unknown error"}`,
          "error"
        );
        return;
      }
      const removed = data.removed ?? 0;
      showMessage2(
        removed > 0 ? `Removed ${removed.toLocaleString()} leftover placeholder file(s).` : "No leftover placeholder files found.",
        "success"
      );
    });
  };
  var previewDataset = null;
  var previewShown = 0;
  var previewTotal = null;
  var previewExhausted = false;
  var previewBusy = false;
  var ensurePreviewModal = () => {
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
                <div class="modal-footer quarry-preview-footer">
                    <span id="${PREVIEW_STATUS_ID}" class="quarry-preview-status"></span>
                    <span class="quarry-preview-footer-actions">
                        <button type="button" id="${PREVIEW_CLEAR_ID}" class="basic-button" title="Drop this dataset's cached preview rows and reload the first page">Clear cache</button>
                        <button type="button" id="${PREVIEW_LOAD_MORE_ID}" class="basic-button" title="Load and cache ${PREVIEW_LOAD_MORE_COUNT} more rows">Load ${PREVIEW_LOAD_MORE_COUNT} more</button>
                        <button type="button" class="btn btn-secondary basic-button" data-bs-dismiss="modal">Close</button>
                    </span>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.querySelector('[data-bs-dismiss="modal"]')?.addEventListener("click", hidePreviewModal);
    document.getElementById(PREVIEW_LOAD_MORE_ID)?.addEventListener("click", loadMorePreview);
    document.getElementById(PREVIEW_CLEAR_ID)?.addEventListener("click", clearPreviewCache);
  };
  var showPreviewModal = () => {
    if (typeof $ === "function") {
      $(`#${PREVIEW_MODAL_ID}`).modal("show");
    }
  };
  var hidePreviewModal = () => {
    if (typeof $ === "function") {
      $(`#${PREVIEW_MODAL_ID}`).modal("hide");
    }
  };
  var applyRowCount = (dataset, count) => {
    const selector = `td.quarry-dataset-rows[data-dataset="${dataset.replace(/(["\\])/g, "\\$1")}"]`;
    for (const cell of Array.from(
      document.querySelectorAll(selector)
    )) {
      cell.textContent = formatRowCount(count);
    }
    const entry = currentDatasets.find((d) => d.name === dataset);
    if (entry) {
      entry.rowCount = count;
      updateDatasetsSummary();
    }
  };
  var updatePreviewControls = () => {
    const loadMore2 = document.getElementById(
      PREVIEW_LOAD_MORE_ID
    );
    const clear = document.getElementById(
      PREVIEW_CLEAR_ID
    );
    const status = document.getElementById(PREVIEW_STATUS_ID);
    if (loadMore2) {
      loadMore2.disabled = previewBusy || previewExhausted || !previewDataset;
    }
    if (clear) {
      clear.disabled = previewBusy || !previewDataset;
    }
    if (status) {
      status.textContent = previewBusy ? "Loading…" : renderPreviewStatus(previewShown, previewTotal);
    }
  };
  var fetchPreview = (dataset, limit, isLoadMore) => {
    previewBusy = true;
    updatePreviewControls();
    genericRequest(
      "QuarryPreviewDataset",
      { dataset, limit },
      (data) => {
        previewBusy = false;
        if (previewDataset !== dataset) {
          return;
        }
        const bodyEl = document.getElementById(PREVIEW_BODY_ID);
        if (!data.success) {
          if (bodyEl && !isLoadMore) {
            bodyEl.innerHTML = `<div class="quarry-preview-error">${escapeHtml(data.error ?? "Failed to load preview.")}</div>`;
          }
          updatePreviewControls();
          return;
        }
        const columns = data.columns ?? [];
        const rows = data.rows ?? [];
        previewShown = rows.length;
        previewTotal = data.rowCount ?? null;
        previewExhausted = rows.length < limit || previewTotal !== null && previewShown >= previewTotal;
        applyRowCount(dataset, previewTotal);
        if (bodyEl) {
          bodyEl.innerHTML = renderPreviewTable(columns, rows);
        }
        updatePreviewControls();
      }
    );
  };
  var openPreview = (dataset) => {
    ensurePreviewModal();
    previewDataset = dataset;
    previewShown = 0;
    previewTotal = null;
    previewExhausted = false;
    const titleEl = document.getElementById(PREVIEW_TITLE_ID);
    if (titleEl) {
      titleEl.textContent = `Preview — ${dataset}`;
    }
    const bodyEl = document.getElementById(PREVIEW_BODY_ID);
    if (bodyEl) {
      bodyEl.innerHTML = `<div class="quarry-preview-loading">Loading…</div>`;
    }
    showPreviewModal();
    fetchPreview(dataset, PREVIEW_ROW_LIMIT, false);
  };
  var loadMorePreview = () => {
    if (!previewDataset || previewBusy || previewExhausted) {
      return;
    }
    fetchPreview(previewDataset, previewShown + PREVIEW_LOAD_MORE_COUNT, true);
  };
  var clearPreviewCache = () => {
    const dataset = previewDataset;
    if (!dataset || previewBusy) {
      return;
    }
    previewBusy = true;
    updatePreviewControls();
    genericRequest(
      "QuarryClearPreviewCache",
      { dataset },
      (data) => {
        previewBusy = false;
        if (previewDataset !== dataset) {
          return;
        }
        if (!data.success) {
          updatePreviewControls();
          return;
        }
        previewShown = 0;
        previewExhausted = false;
        const bodyEl = document.getElementById(PREVIEW_BODY_ID);
        if (bodyEl) {
          bodyEl.innerHTML = `<div class="quarry-preview-loading">Loading…</div>`;
        }
        fetchPreview(dataset, PREVIEW_ROW_LIMIT, false);
      }
    );
  };
  var toggleFolder2 = (toggle) => {
    const folder = toggle.getAttribute("data-folder");
    const row = toggle.closest(".quarry-folder-row");
    if (!folder || !row) {
      return;
    }
    const collapsed = row.classList.toggle("quarry-collapsed");
    toggle.setAttribute("aria-expanded", String(!collapsed));
    if (collapsed) {
      expandedFolders2.delete(folder);
    } else {
      expandedFolders2.add(folder);
    }
    const container = document.getElementById("quarry-datasets");
    if (container) {
      refreshFolderVisibility(container, expandedFolders2);
    }
  };
  var applyEnabledState = (button, enabled) => {
    button.setAttribute("aria-checked", String(enabled));
    button.classList.toggle("quarry-enabled", enabled);
    button.classList.toggle("quarry-disabled", !enabled);
    button.setAttribute("title", enabled ? ENABLE_TITLE : DISABLE_TITLE);
    button.closest(".quarry-dataset-row")?.classList.toggle("quarry-dataset-disabled", !enabled);
  };
  var toggleDatasetEnabled = (button) => {
    const name = button.getAttribute("data-dataset");
    if (!name) {
      return;
    }
    const next = button.getAttribute("aria-checked") === "false";
    applyEnabledState(button, next);
    button.disabled = true;
    genericRequest(
      "QuarrySetDatasetEnabled",
      { dataset: name, enabled: next },
      (data) => {
        button.disabled = false;
        if (data.success) {
          recomputeReferences();
        } else {
          applyEnabledState(button, !next);
          showMessage2(
            `Failed to ${next ? "enable" : "disable"} '${name}': ${data.error ?? "unknown error"}`,
            "error"
          );
        }
      }
    );
  };
  var datasetsClickHandler = (event) => {
    const target = event.target;
    const folderToggle = target?.closest(".quarry-folder-toggle");
    if (folderToggle) {
      toggleFolder2(folderToggle);
      return;
    }
    const enableToggle = target?.closest(".quarry-dataset-enable");
    if (enableToggle) {
      toggleDatasetEnabled(enableToggle);
      return;
    }
    const previewButton = target?.closest(
      ".quarry-preview-button"
    );
    if (previewButton) {
      const dataset = previewButton.getAttribute("data-dataset");
      if (dataset) {
        openPreview(dataset);
      }
      return;
    }
    const nameCell = target?.closest(".quarry-dataset-name-cell");
    if (nameCell) {
      const dataset = nameCell.querySelector(".quarry-dataset-name-link")?.getAttribute("data-dataset");
      if (dataset) {
        insertQuarryTag(dataset);
      }
    }
  };
  var ensureFormRendered = () => {
    if (document.getElementById("quarry-form")) {
      return;
    }
    const host = document.getElementById(QUARRY_TAB_BODY_ID);
    if (!host) {
      return;
    }
    host.innerHTML = renderForm("");
    document.getElementById("quarry-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      saveSettings();
    });
    document.getElementById("quarry-refresh")?.addEventListener("click", refresh);
    document.getElementById("quarry-clean-temp")?.addEventListener("click", cleanTempFiles);
    document.getElementById("quarry-download-datasets")?.addEventListener("click", () => openDownloadModal(loadSettings));
    document.getElementById("quarry-datasets")?.addEventListener("click", datasetsClickHandler);
    document.getElementById(ADD_TO_EXISTING_TAG_ID)?.addEventListener("change", (event) => {
      setAddToExistingTag(event.target.checked);
    });
  };
  var installRequirements = () => {
    const button = document.getElementById(
      "quarry-install"
    );
    const status = document.getElementById("quarry-install-status");
    if (button) {
      button.disabled = true;
    }
    if (status) {
      status.textContent = "Installing… downloading the DuckDB lance extension (~235 MB). This can take a few minutes — please wait.";
    }
    genericRequest("QuarryInstallRequirements", {}, (data) => {
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
  var showInstallGate = () => {
    if (document.getElementById("quarry-install")) {
      return;
    }
    const host = document.getElementById(QUARRY_TAB_BODY_ID);
    if (!host) {
      return;
    }
    host.innerHTML = renderInstallGate();
    document.getElementById("quarry-install")?.addEventListener("click", installRequirements);
  };
  var init = () => {
    const host = document.getElementById(QUARRY_TAB_BODY_ID);
    if (!host) {
      return;
    }
    host.innerHTML = `<div class="quarry-loading">Loading…</div>`;
    loadSettings();
    onReferences(applyTableHighlights);
  };
  var quarry = {
    init
  };

  // frontend/main.ts
  injectQuarryTab();
  injectImageSearchTab(initImageSearch);
  var boot = () => {
    quarry.init();
    startPromptWatcher();
    registerQuarryCompletion();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
//# sourceMappingURL=quarry.js.map
