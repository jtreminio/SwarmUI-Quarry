"use strict";
(() => {
  // frontend/settings.ts
  var MESSAGE_TIMEOUT_MS = 5e3;
  var PREVIEW_ROW_LIMIT = 100;
  var PREVIEW_MODAL_ID = "quarry-preview-modal";
  var PREVIEW_TITLE_ID = "quarry-preview-title";
  var PREVIEW_BODY_ID = "quarry-preview-body";
  var escapeHtml = (text) => {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  };
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
  var renderDatasetRow = (dataset) => {
    const name = escapeHtml(dataset.name);
    if (dataset.error) {
      return `<tr class="quarry-dataset-row quarry-dataset-error">
            <td><code class="quarry-dataset-name">${name}</code></td>
            <td colspan="4"><span class="quarry-dataset-error-msg">⚠️ ${escapeHtml(dataset.error)}</span></td>
        </tr>`;
    }
    return `<tr class="quarry-dataset-row">
        <td><code class="quarry-dataset-name">${name}</code></td>
        <td><select class="quarry-dataset-column" data-dataset="${name}">${renderDatasetOptions(dataset)}</select></td>
        <td class="quarry-dataset-tags" title="Columns the 'tags' keyword searches across">${renderTagCheckboxes(dataset)}</td>
        <td class="quarry-dataset-rows" title="${formatRowCount(dataset.rowCount)} rows">${formatRowCount(dataset.rowCount)}</td>
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
    }
  };
  var showMessage = (message, type) => {
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
      if (data.success) {
        applyResponse(data);
      }
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
          showMessage("Settings saved.", "success");
        } else {
          showMessage(
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
        genericRequest(
          "TriggerRefresh",
          { refreshType: "wildcards" },
          () => {
          }
        );
        showMessage(data.message ?? "Refreshed.", "success");
      } else {
        showMessage(
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
          bodyEl.innerHTML = renderPreviewTable(
            data.columns ?? [],
            data.rows ?? []
          );
        } else {
          bodyEl.innerHTML = `<div class="quarry-preview-error">${escapeHtml(data.error ?? "Failed to load preview.")}</div>`;
        }
      }
    );
  };
  var init = () => {
    const tool = registerNewTool("quarry", "Quarry");
    tool.innerHTML = renderForm(false, "");
    loadSettings();
    document.getElementById("quarry-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      saveSettings();
    });
    document.getElementById("quarry-refresh")?.addEventListener("click", refresh);
    document.getElementById("quarry-datasets")?.addEventListener("click", (event) => {
      const target = event.target;
      const button = target?.closest(
        ".quarry-preview-button"
      );
      const dataset = button?.getAttribute("data-dataset");
      if (dataset) {
        openPreview(dataset);
      }
    });
  };
  var quarry = {
    init
  };

  // frontend/main.ts
  document.addEventListener("DOMContentLoaded", () => {
    quarry.init();
  });
})();
//# sourceMappingURL=quarry.js.map
