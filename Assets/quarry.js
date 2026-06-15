"use strict";
(() => {
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
  var matchQuarryTag = (prompt, name) => {
    const matcher = new RegExp(
      `<(q(?:\\[\\d+(?:-\\d+)?\\])?):${regexEscape(name)}>`,
      "g"
    );
    return prompt.match(matcher);
  };
  var insertQuarryTag = (name) => {
    let [promptBox, cursorPos] = uiImprover.getLastSelectedTextbox();
    if (!promptBox) {
      promptBox = getRequiredElementById(
        "alt_prompt_textbox"
      );
      cursorPos = promptBox.value.length;
    }
    const prefix = promptBox.value.substring(0, cursorPos);
    const suffix = promptBox.value.substring(cursorPos);
    const trimmed = trimSpaces(prefix);
    const match = matchQuarryTag(trimmed, name);
    if (match && match.length > 0) {
      const last = match[match.length - 1];
      if (trimmed.endsWith(trimSpaces(last))) {
        promptBox.value = `${trimSpaces(trimmed.substring(0, trimmed.length - last.length))} ${suffix}`.trim();
        triggerChangeFor(promptBox);
        recomputeReferences();
        return;
      }
    }
    const tag = `<q:${name}>`;
    promptBox.value = `${trimSpaces(prefix)} ${tag} ${trimSpaces(suffix)}`.trim();
    promptBox.selectionStart = cursorPos + tag.length + 1;
    promptBox.selectionEnd = cursorPos + tag.length + 1;
    promptBox.focus();
    triggerChangeFor(promptBox);
    recomputeReferences();
  };

  // frontend/util.ts
  var escapeHtml = (text) => {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
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

  // frontend/download.ts
  var MODAL_ID = "quarry-download-modal";
  var BODY_ID = "quarry-download-body";
  var MESSAGE_ID = "quarry-download-message";
  var POLL_MS = 800;
  var renderRemoteDatasetRow = (dataset) => {
    const name = escapeHtml(dataset.name);
    const installed = dataset.installed;
    const rowClass = installed ? "quarry-remote-row quarry-remote-installed" : "quarry-remote-row";
    const check = installed ? `<span class="quarry-remote-check" title="Installed">✓</span> ` : "";
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
  var renderRemoteDatasets = (list) => {
    if (!list || list.length === 0) {
      return `<div class="quarry-remote-empty">No datasets available right now.</div>`;
    }
    return `<table class="quarry-remote-table">
        <thead><tr><th>Dataset</th><th>Size</th><th>Action</th></tr></thead>
        <tbody>${list.map(renderRemoteDatasetRow).join("")}</tbody>
    </table>`;
  };
  var progressPercent = (status) => {
    const total = status.bytesTotal ?? 0;
    const done = status.bytesDone ?? 0;
    if (total <= 0) {
      return 0;
    }
    return Math.min(100, Math.max(0, Math.round(done / total * 100)));
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
  var downloadingName = null;
  var lastRunId = 0;
  var pollTimer = null;
  var renderNote = () => {
    const repo = repoUrl ? `<a href="${escapeHtml(repoUrl)}" target="_blank" rel="noreferrer noopener">the official collection</a>` : "the official collection";
    const tokenHint = tokenSet ? "" : ` <span class="quarry-download-tokenhint">No HuggingFace token set — this public collection still downloads fine; set a token under the User tab for authenticated downloads.</span>`;
    return `<div class="quarry-download-note">${currentList.length} dataset(s) from ${repo}.${tokenHint}</div>`;
  };
  var renderList = () => {
    const body = document.getElementById(BODY_ID);
    if (body) {
      body.innerHTML = renderNote() + renderRemoteDatasets(currentList);
    }
  };
  var showMessage = (text, type = "info") => {
    const el = document.getElementById(MESSAGE_ID);
    if (!el) {
      return;
    }
    el.textContent = text;
    el.className = text ? `quarry-download-message quarry-download-message-${type}` : "quarry-download-message";
  };
  var renderActionProgress = (status) => `<div class="quarry-dl-progress"><div class="quarry-dl-bar" style="width: ${progressPercent(status)}%"></div></div>
     <div class="quarry-dl-info">${escapeHtml(renderProgressInfo(status))}</div>
     <button type="button" class="basic-button quarry-remote-cancel">Cancel</button>`;
  var rowFor = (name) => {
    const body = document.getElementById(BODY_ID);
    if (!body) {
      return null;
    }
    for (const row of Array.from(
      body.querySelectorAll("tr.quarry-remote-row")
    )) {
      if (row.getAttribute("data-dataset") === name) {
        return row;
      }
    }
    return null;
  };
  var markDownloadingUI = (name) => {
    const body = document.getElementById(BODY_ID);
    if (!body) {
      return;
    }
    for (const button of Array.from(
      body.querySelectorAll(".quarry-remote-download")
    )) {
      button.disabled = true;
    }
    const row = rowFor(name);
    const action = row?.querySelector(".quarry-remote-action");
    if (row && action) {
      row.classList.add("quarry-remote-downloading");
      action.innerHTML = renderActionProgress({
        success: true,
        state: "starting"
      });
    }
  };
  var updateProgressUI = (name, status) => {
    const row = rowFor(name);
    if (!row) {
      return;
    }
    if (!row.querySelector(".quarry-dl-bar")) {
      markDownloadingUI(name);
    }
    const bar = row.querySelector(".quarry-dl-bar");
    const info = row.querySelector(".quarry-dl-info");
    if (bar) {
      bar.style.width = `${progressPercent(status)}%`;
    }
    if (info) {
      info.textContent = renderProgressInfo(status);
    }
  };
  var stopPolling = () => {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };
  var scheduleNextPoll = () => {
    pollTimer = setTimeout(pollOnce, POLL_MS);
  };
  var finishDownload = (status) => {
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
        "error"
      );
    } else if (status.state === "cancelled") {
      renderList();
      showMessage("Download cancelled.", "info");
    } else {
      renderList();
    }
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
          if (status.dataset) {
            updateProgressUI(status.dataset, status);
          }
          scheduleNextPoll();
          return;
        }
        if (lastRunId === 0 || status.id === lastRunId) {
          finishDownload(status);
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
  var resumeIfActive = () => {
    genericRequest(
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
      }
    );
  };
  var startDownload = (name, redownload) => {
    if (downloadingName) {
      return;
    }
    showMessage("");
    genericRequest(
      "QuarryDownloadDataset",
      { dataset: name, redownload },
      (data) => {
        if (!data.success) {
          showMessage(
            data.error ?? "Could not start the download.",
            "error"
          );
          return;
        }
        downloadingName = name;
        lastRunId = data.id ?? 0;
        markDownloadingUI(name);
        startPolling();
      }
    );
  };
  var cancelDownload = () => {
    showMessage("Cancelling…", "info");
    genericRequest("QuarryCancelDownload", {}, () => {
    });
  };
  var loadAvailable = () => {
    const body = document.getElementById(BODY_ID);
    if (body) {
      body.innerHTML = `<div class="quarry-download-loading">Loading…</div>`;
    }
    genericRequest(
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
      }
    );
  };
  var bodyClickHandler = (event) => {
    const target = event.target;
    const downloadButton = target?.closest(
      ".quarry-remote-download"
    );
    if (downloadButton) {
      const name = downloadButton.getAttribute("data-dataset");
      const redownload = downloadButton.getAttribute("data-redownload") === "true";
      if (name) {
        startDownload(name, redownload);
      }
      return;
    }
    if (target?.closest(".quarry-remote-cancel")) {
      cancelDownload();
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
    modal.querySelector('[data-bs-dismiss="modal"]')?.addEventListener("click", hideDownloadModal);
    document.getElementById(BODY_ID)?.addEventListener("click", bodyClickHandler);
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
  var TAB_ID = "Quarry-Tab";
  var QUARRY_TAB_BODY_ID = "quarry-tab-body";
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
  var injectQuarryTab = () => {
    const nav = document.getElementById("bottombartabcollection");
    const content = document.getElementById("t2i_bottom_bar_content");
    if (!nav || !content || document.getElementById(TAB_ID)) {
      return;
    }
    const li = document.createElement("li");
    li.className = "nav-item";
    li.setAttribute("role", "presentation");
    li.innerHTML = `<a class="nav-link translate" data-bs-toggle="tab" href="#${TAB_ID}" aria-selected="false" tabindex="-1" role="tab">Quarry</a>`;
    const toolsNav = nav.querySelector('a[href="#Tools-Tab"]');
    if (toolsNav?.parentElement) {
      nav.insertBefore(li, toolsNav.parentElement);
    } else {
      nav.appendChild(li);
    }
    const pane = document.createElement("div");
    pane.className = "tab-pane genpage-bottom-tab";
    pane.id = TAB_ID;
    pane.setAttribute("role", "tabpanel");
    pane.innerHTML = `<div class="quarry-tab-body" id="${QUARRY_TAB_BODY_ID}"></div>`;
    content.appendChild(pane);
    const navLink = li.querySelector("a");
    if (navLink) {
      registerTabWithLayout(navLink);
    }
  };

  // frontend/settings.ts
  var MESSAGE_TIMEOUT_MS = 5e3;
  var PREVIEW_ROW_LIMIT = 100;
  var PREVIEW_MODAL_ID = "quarry-preview-modal";
  var PREVIEW_TITLE_ID = "quarry-preview-title";
  var PREVIEW_BODY_ID = "quarry-preview-body";
  var renderStatus = (active, count) => active ? `<span class="quarry-status-active">✓ Active — ${count} dataset(s)</span>` : `<span class="quarry-status-inactive">○ Inactive — enable and set a folder to activate</span>`;
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
  var applyInPromptHighlights = (container, names) => {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    container.querySelectorAll("tr.quarry-dataset-row").forEach((row) => {
      const name = (row.getAttribute("data-dataset") ?? "").toLowerCase();
      row.classList.toggle("quarry-dataset-in-prompt", wanted.has(name));
    });
  };
  var renderDatasetNameButton = (name) => `<button type="button" class="quarry-dataset-name quarry-dataset-name-link" data-dataset="${name}" title="Add a reference to this dataset to your prompt">${name}</button>`;
  var renderDatasetRow = (dataset) => {
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
  var renderDatasets = (datasets) => {
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
    const body = rows.map((row) => {
      const cells = columns.map((_, i) => `<td>${escapeHtml(row[i] ?? "")}</td>`).join("");
      return `<tr>${cells}</tr>`;
    }).join("");
    return `<table class="quarry-preview-table simple-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
    </table>`;
  };
  var renderForm = (enabled, folder) => `
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
                        <button type="button" id="quarry-download-datasets" class="basic-button" title="Browse and download ready-made datasets from the official collection">⬇ Download Datasets</button>
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
  var messageTimer = null;
  var applyTableHighlights = (names) => {
    const container = document.getElementById("quarry-datasets");
    if (container) {
      applyInPromptHighlights(container, names);
    }
  };
  var applyResponse = (data) => {
    const enabledEl = document.getElementById(
      "quarry-enabled"
    );
    const folderEl = document.getElementById(
      "quarry-folder"
    );
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
        data.count ?? 0
      );
    }
    const datasetsEl = document.getElementById("quarry-datasets");
    if (datasetsEl) {
      datasetsEl.innerHTML = renderDatasets(data.datasets ?? []);
      recomputeReferences();
    }
  };
  var showMessage2 = (message, type) => {
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
    const enabled = document.getElementById("quarry-enabled").checked;
    const folder = document.getElementById("quarry-folder").value.trim();
    const container = document.getElementById("quarry-datasets");
    const promptColumns = container ? collectPromptColumns(container) : {};
    const tagColumns = container ? collectTagColumns(container) : {};
    genericRequest(
      "QuarrySaveSettings",
      {
        enabled,
        datasetsFolder: folder,
        promptColumnsJson: JSON.stringify(promptColumns),
        tagColumnsJson: JSON.stringify(tagColumns)
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
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary basic-button" data-bs-dismiss="modal">Close</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.querySelector('[data-bs-dismiss="modal"]')?.addEventListener("click", hidePreviewModal);
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
  };
  var openPreview = (dataset) => {
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
    genericRequest(
      "QuarryPreviewDataset",
      { dataset, limit: PREVIEW_ROW_LIMIT },
      (data) => {
        if (!bodyEl) {
          return;
        }
        if (data.success) {
          const count = data.rowCount ?? null;
          applyRowCount(dataset, count);
          const summary = count == null ? "" : `<div class="quarry-preview-summary">${formatRowCount(count)} row(s).</div>`;
          bodyEl.innerHTML = summary + renderPreviewTable(data.columns ?? [], data.rows ?? []);
        } else {
          bodyEl.innerHTML = `<div class="quarry-preview-error">${escapeHtml(data.error ?? "Failed to load preview.")}</div>`;
        }
      }
    );
  };
  var datasetsClickHandler = (event) => {
    const target = event.target;
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
    const nameButton = target?.closest(
      ".quarry-dataset-name-link"
    );
    if (nameButton) {
      const dataset = nameButton.getAttribute("data-dataset");
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
    host.innerHTML = renderForm(false, "");
    document.getElementById("quarry-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      saveSettings();
    });
    document.getElementById("quarry-refresh")?.addEventListener("click", refresh);
    document.getElementById("quarry-download-datasets")?.addEventListener("click", () => openDownloadModal(loadSettings));
    document.getElementById("quarry-datasets")?.addEventListener("click", datasetsClickHandler);
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
  var boot = () => {
    quarry.init();
    startPromptWatcher();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
//# sourceMappingURL=quarry.js.map
