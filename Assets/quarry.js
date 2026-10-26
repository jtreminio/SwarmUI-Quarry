"use strict";
(() => {
  // frontend/querysyntax.ts
  var querySections = (text) => {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let filterOpen = -1;
    let filterClose = -1;
    let colon = -1;
    let pipe = -1;
    let optionStart = -1;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
        continue;
      }
      if (c === '"' && pipe >= 0) {
        quoted = true;
        continue;
      }
      if (c === "[") {
        if (depth === 0 && colon < 0 && pipe < 0 && filterOpen < 0)
          filterOpen = i;
        depth++;
      } else if (c === "]") {
        depth--;
        if (depth === 0 && colon < 0 && pipe < 0) filterClose = i;
      } else if (depth === 0) {
        if (c === ":" && colon < 0 && pipe < 0) colon = i;
        if (c === "|" && pipe < 0) {
          pipe = i;
          optionStart = i + 1;
        }
        if (c === ";" && pipe >= 0) optionStart = i + 1;
      }
    }
    return { filterOpen, filterClose, colon, pipe, optionStart, quoted };
  };

  // frontend/util.ts
  var escapeHtml = (text) => {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };
  var escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    {
      op: "+=",
      hint: "at least (number, text length, or array count)",
      comparisonOnly: true
    },
    {
      op: "-=",
      hint: "at most (number, text length, or array count)",
      comparisonOnly: true
    }
  ];
  var findDataset = (list, name) => {
    const low = name.trim().toLowerCase();
    return list.find((d) => d.name.toLowerCase() === low) ?? null;
  };
  var filterByFragment = (items, frag, getName, prefixFirst, key = (value) => value.toLowerCase()) => {
    if (frag.length === 0) {
      return items.slice();
    }
    const matched = items.filter((i) => key(getName(i)).includes(frag));
    if (!prefixFirst) {
      return matched;
    }
    const starts = matched.filter((i) => key(getName(i)).startsWith(frag));
    const rest = matched.filter((i) => !key(getName(i)).startsWith(frag));
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
          comparable: col.kind !== "object"
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
  var fieldPathKey = (value) => value.replace(/\[\*\]/g, "[]").split(/(\[[^\]]*\]?)/).map((part) => part.startsWith("[") ? part : part.toLowerCase()).join("");
  var nestedColumns = (columns, datasets2, fragment, output = false, query = "") => {
    const result = [...columns];
    const used = new Set(result.map((c) => fieldPathKey(c.name)));
    const add = (name, hint, comparable) => {
      if (used.has(fieldPathKey(name))) return;
      used.add(fieldPathKey(name));
      result.push({ name, hint, comparable });
    };
    for (const dataset of datasets2) {
      for (const col of dataset.columns) {
        if (!col.fields?.length) {
          if (col.kind === "list")
            add(`${col.name}[]`, "all elements", true);
          continue;
        }
        const selectors = /* @__PURE__ */ new Set(["", "[]", "[0]"]);
        const root = fragment.match(/^([^.[\]]+)(\[[^\]]*\])/);
        if (root?.[1].toLowerCase() === col.name.toLowerCase())
          selectors.add(root[2] === "[*]" ? "[]" : root[2]);
        if (!output) {
          selectors.add("[i]");
          selectors.add("[n]");
        } else {
          for (const match of query.matchAll(
            /([^.[\];: ]+)\[([a-zA-Z_][a-zA-Z_0-9]*)\]/g
          )) {
            if (match[1].toLowerCase() === col.name.toLowerCase())
              selectors.add(`[${match[2]}]`);
          }
        }
        for (const selector of col.kind === "object" ? [""] : selectors) {
          const name = col.name + selector;
          const all = col.kind === "list" && (selector === "" || selector === "[]");
          add(name, all ? "all records" : "selected record", all);
          for (const field of col.fields) {
            add(`${name}.${field.name}`, "record field", !all);
          }
        }
      }
    }
    return result;
  };
  var completeFilterColumn = (suffix, lastOpen, list) => {
    const named = suffix.slice(0, lastOpen).split(",").map((s) => s.trim()).filter((s) => s.length > 0).map((n) => findDataset(list, n)).filter((d) => d !== null);
    if (named.length === 0) {
      return [];
    }
    const inner = suffix.slice(lastOpen + 1);
    const semiIdx = inner.lastIndexOf(";");
    const clause = semiIdx === -1 ? inner : inner.slice(semiIdx + 1);
    if (/[=!]/.test(clause)) {
      return [];
    }
    const head = `<q:${suffix.slice(0, lastOpen + 1 + (semiIdx === -1 ? 0 : semiIdx + 1))}`;
    const fragment = clause.trim();
    const frag = fieldPathKey(fragment);
    const used = /* @__PURE__ */ new Set();
    const columns = nestedColumns(
      named.flatMap(orderColumnsForFilter).filter((col) => {
        const key = fieldPathKey(col.name);
        if (used.has(key)) return false;
        used.add(key);
        return true;
      }),
      named,
      fragment
    );
    const exact = columns.find((c) => fieldPathKey(c.name) === frag);
    if (exact) {
      return FILTER_OPERATORS.filter(
        (o) => !o.comparisonOnly || exact.comparable
      ).map((o) => ({
        apply: `${head}${exact.name}${o.op}`,
        label: o.op,
        hint: o.hint
      }));
    }
    return filterByFragment(
      columns,
      frag,
      (c) => c.name,
      false,
      fieldPathKey
    ).map((c) => ({
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
    const columnsPart = suffix.slice(colonIdx + 1);
    const commaIdx = columnsPart.lastIndexOf(",");
    const outputKey = (value) => fieldPathKey(value).replace(/\[\]/g, "");
    const chosen = new Set(
      columnsPart.slice(0, commaIdx + 1).split(",").map((s) => outputKey(s.trim()))
    );
    const fragment = columnsPart.slice(commaIdx + 1).trim();
    const frag = fieldPathKey(fragment);
    const matches = filterByFragment(
      nestedColumns(
        orderColumnsForPrompt(named),
        named,
        fragment,
        true,
        head
      ).filter((c) => !chosen.has(outputKey(c.name))),
      frag,
      (c) => c.name,
      false,
      fieldPathKey
    );
    if (matches.length === 1 && fieldPathKey(matches[0].name) === frag) {
      return [];
    }
    const applyHead = `<q:${suffix.slice(0, colonIdx + 1)}${columnsPart.slice(0, commaIdx + 1)}`;
    return matches.map((c) => ({
      apply: applyHead + c.name,
      label: c.name,
      hint: c.hint
    }));
  };
  var computeQuarryCompletions = (suffix, list = datasets) => {
    const sections = querySections(suffix);
    if (sections.pipe >= 0) {
      if (sections.quoted) return [];
      const fragment = suffix.slice(sections.optionStart).trim();
      if (fragment.includes("=")) return [];
      const options = [
        { name: "keys", hint: "print field names" },
        {
          name: 'record_separator="',
          hint: "separator between records (rs)"
        },
        {
          name: 'field_separator="',
          hint: "separator between fields (fs)"
        },
        { name: 'rs="', hint: "record separator" },
        { name: 'fs="', hint: "field separator" }
      ];
      return options.filter((o) => o.name.startsWith(fragment)).map((o) => ({
        apply: `<q:${suffix.slice(0, sections.optionStart)}${o.name}`,
        label: o.name,
        hint: o.hint
      }));
    }
    if (sections.colon >= 0)
      return completePromptColumn(suffix, sections.colon, list);
    if (sections.filterOpen >= 0 && sections.filterClose < 0) {
      return completeFilterColumn(suffix, sections.filterOpen, list);
    }
    if (sections.filterClose >= 0) return [];
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
  var PROMPT_BOX_IDS = ["alt_prompt_textbox", "alt_negativeprompt_textbox"];
  var watching = false;
  var lastPromptBox = null;
  var startPromptWatcher = () => {
    if (watching) {
      return;
    }
    watching = true;
    document.addEventListener("focusin", (event) => {
      const target = event.target;
      if (target instanceof HTMLTextAreaElement && [
        ...PROMPT_BOX_IDS,
        "input_prompt",
        "input_negativeprompt"
      ].includes(target.id))
        lastPromptBox = target;
    });
  };
  var Q_TAG_PATTERN = "<(q(?:\\[\\d+(?:-\\d+)?\\])?):([^>]*)>";
  var splitTagInner = (inner) => {
    const sections = querySections(inner);
    const boundary = sections.colon >= 0 ? sections.colon : sections.pipe;
    const head = boundary < 0 ? inner : inner.slice(0, boundary);
    const column = boundary < 0 ? "" : inner.slice(boundary);
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
  var insertTag = (value, cursorPos, tag) => {
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
    return insertTag(value, cursorPos, `<q:${name}>`);
  };
  var editPrompt = (compute) => {
    let [promptBox, cursorPos] = lastPromptBox?.isConnected ? [lastPromptBox, lastPromptBox.selectionEnd] : uiImprover.getLastSelectedTextbox();
    if (!promptBox || promptBox.closest(".quarry-explore")) {
      promptBox = getRequiredElementById(
        "alt_prompt_textbox"
      );
      cursorPos = promptBox.value.length;
    }
    const edit = compute(promptBox.value, cursorPos);
    promptBox.value = edit.value;
    promptBox.selectionStart = edit.cursor;
    promptBox.selectionEnd = edit.cursor;
    promptBox.focus();
    triggerChangeFor(promptBox);
  };
  var insertQuarryTag = (name) => {
    editPrompt((value, cursor) => computePromptEdit(value, cursor, name, true));
  };
  var insertQuarryQuery = (query) => {
    editPrompt((value, cursor) => insertTag(value, cursor, query));
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

  // dataset-sources.json
  var dataset_sources_default = [
    {
      name: "music/webshart.suno-various-94k",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/webshart/suno-various-94k"
    },
    {
      name: "nl/Aconexx.CivitAI-Flux-Prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/Aconexx/CivitAI-Flux-Prompts"
    },
    {
      name: "nl/agentlans.stock-photos-asian-people",
      alias: "nl/agentlans-stock-photos-asian-people",
      sourceUrl: "https://huggingface.co/datasets/agentlans/stock-photos-asian-people"
    },
    {
      name: "nl/akba08.ultra-realistic-cinematic-photography",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/akba08/ultra-realistic-cinematic-photography"
    },
    {
      name: "nl/AlekseyKorshuk.midjourney-prompts-text-dedup",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/AlekseyKorshuk/midjourney-prompts-text-dedup"
    },
    {
      name: "nl/AlekseyKorshuk.product-photography-v1-tiny-prompts-tasks-collage-filtered",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/AlekseyKorshuk/product-photography-v1-tiny-prompts-tasks-collage-filtered"
    },
    {
      name: "nl/AliN96.midjourney-prompts-embeddings",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/AliN96/midjourney-prompts-embeddings"
    },
    {
      name: "nl/BaiqiL.GenAI-Bench",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/BaiqiL/GenAI-Bench"
    },
    {
      name: "nl/CaptionEmporium.flickr-megalith-10m-internvl2-multi-caption",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/CaptionEmporium/flickr-megalith-10m-internvl2-multi-caption"
    },
    {
      name: "nl/CaptionEmporium.laion-pop-llama3.2-11b",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/CaptionEmporium/laion-pop-llama3.2-11b"
    },
    {
      name: "nl/CaptionEmporium.midjourney-niji-1m-llavanext",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/CaptionEmporium/midjourney-niji-1m-llavanext"
    },
    {
      name: "nl/caqlayan.prompts2",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/caqlayan/prompts2"
    },
    {
      name: "nl/chinoll.Danbooru2024-Webp-4MPixel-NL",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/chinoll/Danbooru2024-Webp-4MPixel-NL"
    },
    {
      name: "nl/ChrisGoringe.flux_prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/ChrisGoringe/flux_prompts"
    },
    {
      name: "nl/CodeGoat24.UniGenBench",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/CodeGoat24/UniGenBench"
    },
    {
      name: "nl/codeShare.chroma_prompts.anime_captions",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/codeShare/chroma_prompts"
    },
    {
      name: "nl/codeShare.chroma_prompts.photoreal",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/codeShare/chroma_prompts"
    },
    {
      name: "nl/codeShare.chroma_prompts.reddit_captions",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/codeShare/chroma_prompts"
    },
    {
      name: "nl/csuhan.midjourney-prompts-FLUX",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/csuhan/midjourney-prompts-FLUX"
    },
    {
      name: "nl/DamarJati.mj-disney",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/DamarJati/mj-disney"
    },
    {
      name: "nl/DamarJati.SD-Prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/DamarJati/SD-Prompts"
    },
    {
      name: "nl/dartags.danbooru-2408-blind-captions",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/dartags/danbooru-2408-blind-captions"
    },
    {
      name: "nl/dnkdnk.CVTG-2K",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/dnkdnk/CVTG-2K"
    },
    {
      name: "nl/Doub7e.ArtBench-2-gpt4o-captions",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/Doub7e/ArtBench-2-gpt4o-captions"
    },
    {
      name: "nl/dvilasuero.awesome_hunyuanImage_prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/dvilasuero/awesome_hunyuanImage_prompts"
    },
    {
      name: "nl/Falah.new_photorealistic_prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/Falah/new_photorealistic_prompts"
    },
    {
      name: "nl/Falah.varied_portrait_prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/Falah/varied_portrait_prompts"
    },
    {
      name: "nl/Felldude.84k_40GB_Captioned_2k_XXX_Images",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/Felldude/84k_40GB_Captioned_2k_XXX_Images"
    },
    {
      name: "nl/Felldude.Human_Corpus_Small",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/Felldude/Human_Corpus_Small"
    },
    {
      name: "nl/Felldude.xxx_hdr_13GB",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/Felldude/xxx_hdr_13GB"
    },
    {
      name: "nl/gaodrew.midjourney-prompts-highquality",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/gaodrew/midjourney-prompts-highquality"
    },
    {
      name: "nl/Geonmo.midjourney-prompts-only",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/Geonmo/midjourney-prompts-only"
    },
    {
      name: "nl/GHonem.fashion_image_caption-3500",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/GHonem/fashion_image_caption-3500"
    },
    {
      name: "nl/isidentical.random-stable-diffusion-prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/isidentical/random-stable-diffusion-prompts"
    },
    {
      name: "nl/jgreely.c1ga",
      alias: "nl/jgreely-c1ga",
      sourceUrl: "https://github.com/jgreely/c1ga"
    },
    {
      name: "nl/jorgevipo.image_prompts_dataset",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/jorgevipo/image_prompts_dataset"
    },
    {
      name: "nl/jtreminio.artist_styles",
      alias: null,
      sourceUrl: "https://huggingface.co/jtreminio"
    },
    {
      name: "nl/juliaturc.captioned-cartoons",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/juliaturc/captioned-cartoons"
    },
    {
      name: "nl/k-mktr.improved-flux-prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/k-mktr/improved-flux-prompts"
    },
    {
      name: "nl/k-mktr.improved-flux-prompts-photoreal-portrait",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/k-mktr/improved-flux-prompts-photoreal-portrait"
    },
    {
      name: "nl/k-mktr.trending-text-to-image",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/k-mktr/trending-text-to-image"
    },
    {
      name: "nl/k-mktr.z-image-ethnicity-test",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/k-mktr/z-image-ethnicity-test"
    },
    {
      name: "nl/k-mktr.z-image-examples",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/k-mktr/z-image-examples"
    },
    {
      name: "nl/kaupane.vintage-photography-captions",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/kaupane/vintage-photography-captions"
    },
    {
      name: "nl/KBlueLeaf.danbooru2023-florence2-caption",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/KBlueLeaf/danbooru2023-florence2-caption"
    },
    {
      name: "nl/lioooox.T2I-CoReBench",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/lioooox/T2I-CoReBench"
    },
    {
      name: "nl/Mediocreatmybest.Miscellany_of_Australian_Historical_Photography",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/Mediocreatmybest/Miscellany_of_Australian_Historical_Photography"
    },
    {
      name: "nl/mnemic.200k-random-prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/mnemic/200k-random-prompts"
    },
    {
      name: "nl/MohamedRashad.midjourney-detailed-prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/MohamedRashad/midjourney-detailed-prompts"
    },
    {
      name: "nl/nixiieee.wikiart_captions",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/nixiieee/wikiart_captions"
    },
    {
      name: "nl/opendiffusionai.pexels-woman-croppable",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/opendiffusionai/pexels-woman-croppable"
    },
    {
      name: "nl/ossaili.archdaily_30k_captioned",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/ossaili/archdaily_30k_captioned"
    },
    {
      name: "nl/Owen777.9M_77Token_SDXL_Prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/Owen777/9M_77Token_SDXL_Prompts"
    },
    {
      name: "nl/Pratofeitoo.fashion_photography_prompts_SDXL",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/Pratofeitoo/fashion_photography_prompts_SDXL"
    },
    {
      name: "nl/quarterturn.danbooru-1024-eq-captioned",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/quarterturn/danbooru-1024-eq-captioned"
    },
    {
      name: "nl/quik-models.captions-100k",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/quik-models/captions-100k"
    },
    {
      name: "nl/RicemanT.Anime-Background-Finetuning-V1.1.screencap",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/RicemanT/Anime-Background-Finetuning-V1.1"
    },
    {
      name: "nl/RicemanT.booru-essence-2026.danbooru",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/RicemanT/booru-essence-2026"
    },
    {
      name: "nl/RicemanT.booru-essence-2026.e621",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/RicemanT/booru-essence-2026"
    },
    {
      name: "nl/roborovski.upsampled-prompts-parti",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/roborovski/upsampled-prompts-parti"
    },
    {
      name: "nl/sengunsipahi.civitai_top10k",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/sengunsipahi/civitai_top10k"
    },
    {
      name: "nl/SilentAntagonist.vintage-artworks-60k-captioned",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/SilentAntagonist/vintage-artworks-60k-captioned"
    },
    {
      name: "nl/SilentAntagonist.vintage-photography-450k-high-quality-captions",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/SilentAntagonist/vintage-photography-450k-high-quality-captions"
    },
    {
      name: "nl/stablellama.erotic-image-prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/stablellama/erotic-image-prompts"
    },
    {
      name: "nl/svjack.conceptual_captions_3m_en_tiny",
      alias: "nl/svjack-conceptual_captions_3m_en_tiny",
      sourceUrl: "https://huggingface.co/datasets/svjack/conceptual_captions_3m_en_tiny"
    },
    {
      name: "nl/taoki.stair-captions-prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/taoki/stair-captions-prompts"
    },
    {
      name: "nl/tommmyhug.concept-art-female-anime-realism-fantasy-cyberpunk-steampunk-post-apocalypse-art-prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/tommmyhug/concept-art-female-anime-realism-fantasy-cyberpunk-steampunk-post-apocalypse-art-prompts"
    },
    {
      name: "nl/unography.shopify-stock-images-2048-captioned",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/unography/shopify-stock-images-2048-captioned"
    },
    {
      name: "nl/victorzarzu.interior-design-edit-captions",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/victorzarzu/interior-design-edit-captions"
    },
    {
      name: "nl/visheratin.unsplash-caption-questions-init",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/visheratin/unsplash-caption-questions-init"
    },
    {
      name: "nl/webshart.pseudo-camera-10k-structured",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/webshart/pseudo-camera-10k-structured"
    },
    {
      name: "nl/webshart.terminusresearch-photo-aesthetics",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/webshart/terminusresearch-photo-aesthetics"
    },
    {
      name: "nl/webshart.terminusresearch-photo-anatomy",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/webshart/terminusresearch-photo-anatomy"
    },
    {
      name: "nl/webshart.terminusresearch-photo-typography",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/webshart/terminusresearch-photo-typography"
    },
    {
      name: "short-stories/agentlans.Gemma-2-Ataraxy-9B-short-stories",
      alias: "short-stories/agentlans-Gemma-2-Ataraxy-9B-short-stories",
      sourceUrl: "https://huggingface.co/datasets/agentlans/Gemma-2-Ataraxy-9B-short-stories"
    },
    {
      name: "short-stories/agentlans.lemonilia-LimaRP",
      alias: "short-stories/agentlans-lemonilia-LimaRP",
      sourceUrl: "https://huggingface.co/datasets/agentlans/lemonilia-LimaRP"
    },
    {
      name: "short-stories/agentlans.lemonilia-LimaRP.scenario",
      alias: "short-stories/agentlans-lemonilia-LimaRP-scenario",
      sourceUrl: "https://huggingface.co/datasets/agentlans/lemonilia-LimaRP"
    },
    {
      name: "short-stories/agentlans.lemonilia-LimaRP.user_description",
      alias: "short-stories/agentlans-lemonilia-LimaRP-user_description",
      sourceUrl: "https://huggingface.co/datasets/agentlans/lemonilia-LimaRP"
    },
    {
      name: "short-stories/agentlans.literary-genre-examples",
      alias: "short-stories/agentlans-literary-genre-examples",
      sourceUrl: "https://huggingface.co/datasets/agentlans/literary-genre-examples"
    },
    {
      name: "short-stories/agentlans.literary-reasoning",
      alias: "short-stories/agentlans-literary-reasoning",
      sourceUrl: "https://huggingface.co/datasets/agentlans/literary-reasoning"
    },
    {
      name: "short-stories/agentlans.prompt-difficulty",
      alias: "short-stories/agentlans-prompt-difficulty",
      sourceUrl: "https://huggingface.co/datasets/agentlans/prompt-difficulty"
    },
    {
      name: "short-stories/allura-org.r_shortstories_24k",
      alias: "short-stories/allura-org-r_shortstories_24k",
      sourceUrl: "https://huggingface.co/datasets/allura-org/r_shortstories_24k"
    },
    {
      name: "short-stories/allura-org.SynthRP-RpR-converted",
      alias: "short-stories/allura-org-SynthRP-RpR-converted",
      sourceUrl: "https://huggingface.co/datasets/allura-org/SynthRP-RpR-converted"
    },
    {
      name: "short-stories/athena-ml.gpt4_short_stories_with_tokens",
      alias: "short-stories/athena-ml-gpt4_short_stories_with_tokens",
      sourceUrl: "https://huggingface.co/datasets/athena-ml/gpt4_short_stories_with_tokens"
    },
    {
      name: "short-stories/Chat-Error.tinystories-gpt4.eval",
      alias: "short-stories/Chat-Error-tinystories-gpt4-eval",
      sourceUrl: "https://huggingface.co/datasets/Chat-Error/tinystories-gpt4"
    },
    {
      name: "short-stories/Chat-Error.tinystories-gpt4.train",
      alias: "short-stories/Chat-Error-tinystories-gpt4-train",
      sourceUrl: "https://huggingface.co/datasets/Chat-Error/tinystories-gpt4"
    },
    {
      name: "short-stories/DataMajin.Data-Majin_Short-Stories",
      alias: "short-stories/DataMajin-Data-Majin_Short-Stories",
      sourceUrl: "https://huggingface.co/datasets/DataMajin/Data-Majin_Short-Stories"
    },
    {
      name: "short-stories/dltdojo.park-tinystories-533k",
      alias: "short-stories/dltdojo-park-tinystories-533k",
      sourceUrl: "https://huggingface.co/datasets/dltdojo/park-tinystories-533k"
    },
    {
      name: "short-stories/lordgrim18.short-stories",
      alias: "short-stories/lordgrim18-short-stories",
      sourceUrl: "https://huggingface.co/datasets/lordgrim18/short-stories"
    },
    {
      name: "short-stories/NewEden-Forge.Erebus-R_ShortStories-Combined",
      alias: "short-stories/NewEden-Forge-Erebus-R_ShortStories-Combined",
      sourceUrl: "https://huggingface.co/datasets/NewEden-Forge/Erebus-R_ShortStories-Combined"
    },
    {
      name: "short-stories/roneneldan.TinyStories",
      alias: "short-stories/roneneldan-TinyStories",
      sourceUrl: "https://huggingface.co/datasets/roneneldan/TinyStories"
    },
    {
      name: "short-stories/roneneldan.TinyStories.TinyStoriesV2-GPT4-train",
      alias: "short-stories/TinyStoriesV2-GPT4-train",
      sourceUrl: "https://huggingface.co/datasets/roneneldan/TinyStories"
    },
    {
      name: "short-stories/SicariusSicariiStuff.No_Robots_ShareGPT",
      alias: "short-stories/SicariusSicariiStuff-No_Robots_ShareGPT",
      sourceUrl: "https://huggingface.co/datasets/SicariusSicariiStuff/No_Robots_ShareGPT"
    },
    {
      name: "short-stories/SicariusSicariiStuff.Reddit_Dirty_Writing_Prompts_ShareGPT",
      alias: "short-stories/SicariusSicariiStuff-Reddit_Dirty_Writing_Prompts_ShareGPT",
      sourceUrl: "https://huggingface.co/datasets/SicariusSicariiStuff/Reddit_Dirty_Writing_Prompts_ShareGPT"
    },
    {
      name: "short-stories/SicariusSicariiStuff.Short_Stories_ShareGPT.Short_Stories_ShareGPT1",
      alias: "short-stories/SicariusSicariiStuff-Short_Stories_ShareGPT1",
      sourceUrl: "https://huggingface.co/datasets/SicariusSicariiStuff/Short_Stories_ShareGPT"
    },
    {
      name: "short-stories/skeskinen.TinyStories-hf",
      alias: "short-stories/skeskinen-TinyStories-hf",
      sourceUrl: "https://huggingface.co/datasets/skeskinen/TinyStories-hf"
    },
    {
      name: "tags/chengli-thu.anime-character-prompt-15k",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/chengli-thu/anime-character-prompt-15k"
    },
    {
      name: "tags/civitai",
      alias: null,
      sourceUrl: null
    },
    {
      name: "tags/civitai.author_prompts",
      alias: null,
      sourceUrl: null
    },
    {
      name: "tags/CyberHarem",
      alias: null,
      sourceUrl: "https://huggingface.co/CyberHarem"
    },
    {
      name: "tags/daspartho.stable-diffusion-prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/daspartho/stable-diffusion-prompts"
    },
    {
      name: "tags/deepghs.sankaku_full",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/deepghs/sankaku_full"
    },
    {
      name: "tags/Falah.anime_arabic_style_prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/Falah/anime_arabic_style_prompts"
    },
    {
      name: "tags/FredZhang7.anime-prompts-180K",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/FredZhang7/anime-prompts-180K"
    },
    {
      name: "tags/gnokit.stable-diffusion-prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/gnokit/stable-diffusion-prompts"
    },
    {
      name: "tags/Gustavosta.Stable-Diffusion-Prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/Gustavosta/Stable-Diffusion-Prompts"
    },
    {
      name: "tags/huzaib.stable-diffusion-prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/huzaib/stable-diffusion-prompts"
    },
    {
      name: "tags/jgreely.c1ga",
      alias: null,
      sourceUrl: "https://github.com/jgreely/c1ga"
    },
    {
      name: "tags/jtatman.stable-diffusion-prompts-stats-full-uncensored",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/jtatman/stable-diffusion-prompts-stats-full-uncensored"
    },
    {
      name: "tags/jtatman.stable-diffusion-prompts-uncensored",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/jtatman/stable-diffusion-prompts-uncensored"
    },
    {
      name: "tags/llaa33219.danbooru-anime-screenshot",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/llaa33219/danbooru-anime-screenshot"
    },
    {
      name: "tags/MingSafeR.anime_porn_image_prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/MingSafeR/anime_porn_image_prompts"
    },
    {
      name: "tags/MingSafeR.photo_porn_image_prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/MingSafeR/photo_porn_image_prompts"
    },
    {
      name: "tags/moescape",
      alias: null,
      sourceUrl: null
    },
    {
      name: "tags/Nelis.Midjourney_Stable_Diffusion_prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/Nelis/Midjourney_Stable_Diffusion_prompts"
    },
    {
      name: "tags/Nelis.prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/Nelis/prompts"
    },
    {
      name: "tags/NewEden.CivitAI-SD-Prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/NewEden/CivitAI-SD-Prompts"
    },
    {
      name: "tags/poloclub.diffusiondb",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/poloclub/diffusiondb"
    },
    {
      name: "tags/succinctly.midjourney-prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/succinctly/midjourney-prompts"
    },
    {
      name: "tags/suriyagunasekar.midjourney-prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/suriyagunasekar/midjourney-prompts"
    },
    {
      name: "tags/ThetaCursed.danbooru-2026-clean-metadata",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/ThetaCursed/danbooru-2026-clean-metadata"
    },
    {
      name: "tags/WoWoWoWololo.stable_diffusion_female_prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/WoWoWoWololo/stable_diffusion_female_prompts"
    },
    {
      name: "tags/wtcherr.midjourney-prompts",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/wtcherr/midjourney-prompts"
    },
    {
      name: "tags/X779.Danbooruwildcards.characters_str_tags_danbooru_full",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/X779/Danbooruwildcards"
    },
    {
      name: "tags/X779.Danbooruwildcards/characters_str_tags_danbooru_full",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/X779/Danbooruwildcards"
    },
    {
      name: "video/AdwolfCzar.bouncing_body_jiggle_dataset_captioned_30-07",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/AdwolfCzar/bouncing_body_jiggle_dataset_captioned_30-07"
    },
    {
      name: "video/DSULT-Core.i-love-anime-sakuga.aesthetic",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/DSULT-Core/i-love-anime-sakuga"
    },
    {
      name: "video/DSULT-Core.i-love-anime-sakuga.full",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/DSULT-Core/i-love-anime-sakuga"
    },
    {
      name: "video/GokuScraper.seedance-2-prompts-datasets",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/GokuScraper/seedance-2-prompts-datasets"
    },
    {
      name: "video/MultimodalFriends.AcitvityNet-Captions-bootstrapped-5K",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/MultimodalFriends/AcitvityNet-Captions-bootstrapped-5K"
    },
    {
      name: "video/svjack.Goku_MovieGenBench_Videos_Captioned",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/svjack/Goku_MovieGenBench_Videos_Captioned"
    },
    {
      name: "video/webshart.OpenVid-1M-webshart-indices",
      alias: null,
      sourceUrl: "https://huggingface.co/datasets/webshart/OpenVid-1M-webshart-indices"
    }
  ];

  // frontend/repair.ts
  var bindRepairButton = (onChanged2, onBusy) => {
    const button = document.getElementById(
      "quarry-repair-datasets"
    );
    const status = document.getElementById("quarry-repair-status");
    button?.addEventListener("click", () => {
      if (button.disabled || !status) {
        return;
      }
      button.disabled = true;
      onBusy?.(true);
      button.textContent = "Repairing…";
      status.textContent = "Checking local datasets. No dataset downloads are needed.";
      status.className = "quarry-repair-status";
      const finish = () => {
        button.disabled = false;
        button.textContent = "Repair datasets";
        onBusy?.(false);
      };
      const fail = (error) => {
        finish();
        status.className = "quarry-repair-status quarry-message-error";
        status.textContent = `Repair failed: ${String(error)}. Refresh the dataset list before retrying.`;
      };
      genericRequest(
        "QuarryRepairDatasets",
        {},
        (data) => {
          if (!data.success) {
            fail(data.error ?? "unknown error");
            return;
          }
          finish();
          const repaired = data.repaired ?? 0;
          const checked = data.checked ?? 0;
          const issues = data.issues ?? [];
          const summary = repaired > 0 ? `Repaired ${repaired.toLocaleString()} of ${checked.toLocaleString()} checked datasets without downloading data. Previous metadata was backed up locally.` : `Checked ${checked.toLocaleString()} datasets. No stale-version repairs were made.`;
          status.textContent = [
            summary,
            ...issues.map(
              (issue) => `${issue.dataset}: ${issue.error}`
            )
          ].join("\n");
          status.className = `quarry-repair-status ${issues.length > 0 ? "quarry-message-error" : "quarry-message-success"}`;
          onChanged2();
        },
        0,
        fail
      );
    });
  };

  // frontend/download.ts
  var BODY_ID = "quarry-download-body";
  var MESSAGE_ID = "quarry-download-message";
  var PROGRESS_ID = "quarry-download-progress";
  var START_ID = "quarry-download-start";
  var REFRESH_ID = "quarry-download-refresh";
  var REPAIR_ID = "quarry-repair-datasets";
  var repairing = false;
  var POLL_MS = 800;
  var hasUpdate = (dataset) => dataset.installed && dataset.updateAvailable === true;
  var folderUpdateCount = (node) => node.items.filter(hasUpdate).length + node.folders.reduce((count, child) => count + folderUpdateCount(child), 0);
  var sourceOverrides = /* @__PURE__ */ new Map();
  var sourceLeaves = /* @__PURE__ */ new Map();
  for (const source of dataset_sources_default) {
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
  var sourceRepoUrl = (name) => {
    const key = name.toLowerCase();
    if (sourceOverrides.has(key)) {
      return sourceOverrides.get(key) ?? null;
    }
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
  var renderRemoteDatasetName = (name, displayName = name) => {
    const label = escapeHtml(displayName);
    const url = sourceRepoUrl(name);
    if (!url) {
      return label;
    }
    return `<a class="quarry-remote-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener" title="Open source for ${escapeHtml(name)}">${label}</a>`;
  };
  var renderRemoteDatasetRow = (dataset, displayName = dataset.name, depth = 0, container = null, hidden = false) => {
    const name = escapeHtml(dataset.name);
    const installed = dataset.installed;
    const updateAvailable = hasUpdate(dataset);
    const rowClass = installed ? "quarry-remote-row quarry-remote-installed" : "quarry-remote-row";
    const hiddenClass = hidden ? " quarry-row-hidden" : "";
    const parentAttr = container ? ` data-parent="${escapeHtml(container)}"` : "";
    const check = installed ? `<span class="quarry-remote-check" title="Installed">✓ Installed</span>` : '<span class="quarry-remote-available">Not installed</span>';
    const update = updateAvailable ? ' <span class="quarry-remote-update">Update available!</span>' : "";
    const title = updateAvailable ? "Update available! Select to update" : installed ? "Already installed — select to redownload" : "Select to download";
    return `<tr class="${rowClass}${hiddenClass}" data-dataset="${name}"${parentAttr} style="--quarry-depth: ${depth}">
        <td class="quarry-remote-selcell">
            <input type="checkbox" class="quarry-remote-select" data-dataset="${name}" data-installed="${installed}" data-update="${updateAvailable}" title="${title}" aria-label="Select ${name}" />
        </td>
        <td class="quarry-remote-name">${renderRemoteDatasetName(dataset.name, displayName)}</td>
        <td class="quarry-remote-status">${check}${update}</td>
        <td class="quarry-remote-size">${formatBytes(dataset.sizeBytes)}</td>
    </tr>`;
  };
  var renderRemoteFolderHeaderRow = (node, depth, expanded) => {
    const path = escapeHtml(node.path);
    const collapsed = !expanded.has(node.path);
    const container = datasetFolder(node.path);
    const count = folderDatasetCount(node);
    const updates = folderUpdateCount(node);
    const hiddenClass = allAncestorsExpanded(container, expanded) ? "" : " quarry-row-hidden";
    const collapsedClass = collapsed ? " quarry-collapsed" : "";
    const parentAttr = container ? ` data-parent="${escapeHtml(container)}"` : "";
    return `<tr class="quarry-folder-row${collapsedClass}${hiddenClass}" data-folder="${path}"${parentAttr} style="--quarry-depth: ${depth}">
        <td colspan="4">
            <button type="button" class="quarry-folder-toggle" data-folder="${path}" aria-expanded="${!collapsed}" title="Show or hide the datasets in this folder">
                <span class="quarry-folder-caret" aria-hidden="true"></span>
                <span class="quarry-folder-name">${escapeHtml(node.name)}</span>
                <span class="quarry-folder-count" title="${count} dataset(s)">${count}</span>
                ${updates ? `<span class="quarry-remote-update">${updates} update${updates === 1 ? "" : "s"} available!</span>` : ""}
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
  var renderRemoteDatasets = (list, expandedFolders2 = /* @__PURE__ */ new Set()) => {
    if (!list || list.length === 0) {
      return `<div class="quarry-remote-empty">No datasets available right now.</div>`;
    }
    const { loose, folders } = buildFolderTree(list);
    const folderRows = folders.map((folder) => renderRemoteFolderNode(folder, 0, expandedFolders2)).join("");
    const looseRows = loose.map((dataset) => renderRemoteDatasetRow(dataset)).join("");
    return `<table class="quarry-remote-table">
        <colgroup><col class="quarry-remote-col-select"><col><col class="quarry-remote-col-status"><col class="quarry-remote-col-size"></colgroup>
        <thead><tr>
            <th class="quarry-remote-selcell"><input type="checkbox" class="quarry-remote-selectall" title="Select all" aria-label="Select all datasets" /></th>
            <th>Dataset</th>
            <th>Status</th>
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
    const updates = currentList.filter(hasUpdate).length;
    const updateNotice = updates ? `<div class="quarry-download-updates"><span class="quarry-remote-update">${updates} update${updates === 1 ? "" : "s"} available!</span> <button type="button" class="basic-button quarry-select-updates">Select updates</button></div>` : "";
    return `<div class="quarry-download-note">${currentList.length} dataset(s) from ${repo}. Select datasets to download or update.${tokenHint}</div>${updateNotice}`;
  };
  var renderList = () => {
    const body2 = document.getElementById(BODY_ID);
    if (body2) {
      body2.innerHTML = `<div class="quarry-download-summary">${renderNote()}</div><div class="quarry-download-list" tabindex="0" role="region" aria-label="Available datasets">${renderRemoteDatasets(currentList, expandedFolders)}</div>`;
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
      const selected = rowCheckboxes().filter((cb) => cb.checked);
      start.disabled = repairing || downloadingName !== null || selected.length === 0;
      start.textContent = selected.length > 0 && selected.every((cb) => cb.dataset.update === "true") ? "Update selected" : "Download selected";
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
    downloading = downloading || repairing;
    const repair = document.getElementById(
      REPAIR_ID
    );
    if (repair) {
      repair.disabled = downloading;
    }
    const body2 = document.getElementById(BODY_ID);
    if (body2) {
      for (const cb of Array.from(
        body2.querySelectorAll(
          ".quarry-remote-select, .quarry-remote-selectall, .quarry-select-updates"
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
    pollTimer = setTimeout(pollOnce, POLL_MS);
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
        entry.updateAvailable = false;
      }
      renderList();
      setControlsDownloading(true);
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
    const selectUpdates = target?.closest(
      ".quarry-select-updates"
    );
    if (selectUpdates && !selectUpdates.disabled) {
      for (const cb of rowCheckboxes()) {
        cb.checked = cb.dataset.update === "true";
      }
      updateSelectAllState();
      updateStartButtonState();
    }
    const folderToggle = target?.closest(".quarry-folder-toggle");
    if (folderToggle) {
      toggleFolder(folderToggle);
    }
  };
  var mountDownloads = (host, onChangedCb) => {
    onChanged = onChangedCb;
    if (host.querySelector(`#${BODY_ID}`)) return;
    host.innerHTML = `
        <div class="quarry-download-toolbar">
            <button type="button" id="${REFRESH_ID}" class="basic-button">Refresh collection</button>
            <button type="button" id="${REPAIR_ID}" class="basic-button" title="Fix casing errors caused by stale downloaded versions using existing local files. No dataset download is needed; previous metadata is backed up.">Repair datasets</button>
            <button type="button" id="${START_ID}" class="basic-button quarry-download-primary" disabled>Download selected</button>
        </div>
        <div id="${BODY_ID}" class="quarry-download-body"></div>
        <div id="${PROGRESS_ID}" class="quarry-download-progress" style="display: none;"></div>
        <div id="${MESSAGE_ID}" class="quarry-download-message" role="status"></div>
        <div id="quarry-repair-status" class="quarry-repair-status" role="status" aria-live="polite"></div>
`;
    document.getElementById(START_ID)?.addEventListener("click", startBatch);
    document.getElementById(REFRESH_ID)?.addEventListener("click", () => loadAvailable(true));
    bindRepairButton(
      () => onChanged?.(),
      (busy) => {
        repairing = busy;
        setControlsDownloading(downloadingName !== null);
      }
    );
    document.getElementById(BODY_ID)?.addEventListener("change", bodyChangeHandler);
    document.getElementById(BODY_ID)?.addEventListener("click", bodyClickHandler);
    document.getElementById(PROGRESS_ID)?.addEventListener("click", progressClickHandler);
    loadAvailable();
  };

  // frontend/clipboard.ts
  var copyToClipboard = async (text, container) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
    }
    const active = document.activeElement;
    const input = document.createElement("textarea");
    input.value = text;
    input.readOnly = true;
    input.style.cssText = "position:fixed;opacity:0;left:0;top:0;pointer-events:none";
    container.append(input);
    try {
      input.focus({ preventScroll: true });
      input.select();
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      input.remove();
      active?.focus({ preventScroll: true });
    }
  };

  // frontend/exploreDatasets.ts
  var exploreColumns = (dataset) => dataset.columns.flatMap((column) => [
    column,
    ...(column.fields ?? []).map((field) => ({
      name: `${column.name}.${field.name}`,
      kind: "scalar",
      numeric: field.numeric
    }))
  ]);
  var sameType = (left, right) => left.kind === right.kind && !!left.numeric === !!right.numeric;
  var sharedExploreColumns = (datasets2) => datasets2.length ? exploreColumns(datasets2[0]).filter(
    (column) => datasets2.every(
      (dataset) => exploreColumns(dataset).some(
        (candidate) => candidate.name.toLowerCase() === column.name.toLowerCase() && sameType(column, candidate)
      )
    )
  ) : [];
  var datasetCompatibility = (dataset, current, used) => {
    if (dataset.error || !dataset.columns.length)
      return dataset.error || "Dataset has no available fields.";
    const columns = exploreColumns(dataset);
    for (const name of used) {
      const candidate = columns.find(
        (column) => column.name.toLowerCase() === name.toLowerCase()
      );
      if (!candidate) return `Missing field: ${name}`;
      const existing = current.find(
        (column) => column.name.toLowerCase() === name.toLowerCase()
      );
      if (existing && !sameType(existing, candidate))
        return `Different field type: ${name}`;
    }
    return "";
  };

  // frontend/librarySplitter.ts
  var STORAGE_KEY = "barspot_browser_quarry";
  var bindLibrarySplitter = (root) => {
    const handle = root.querySelector(".quarry-library-splitter");
    if (!handle) return () => {
    };
    let width = 0;
    let pointer = null;
    try {
      width = Number(localStorage.getItem(STORAGE_KEY)) || 0;
    } catch {
    }
    const bounds = () => ({
      min: 192,
      max: Math.max(192, root.clientWidth / 2)
    });
    const apply = () => {
      const { min, max } = bounds();
      if (width)
        root.style.setProperty(
          "--quarry-rail-width",
          `${Math.min(max, Math.max(min, width))}px`
        );
      handle.setAttribute("aria-valuemin", String(min));
      handle.setAttribute("aria-valuemax", String(Math.round(max)));
      handle.setAttribute(
        "aria-valuenow",
        String(
          Math.round(
            width ? Math.min(max, Math.max(min, width)) : root.querySelector(
              ".quarry-explore-rail"
            )?.getBoundingClientRect().width ?? min
          )
        )
      );
    };
    const resize = (next) => {
      const { min, max } = bounds();
      width = Math.min(max, Math.max(min, next));
      apply();
      try {
        localStorage.setItem(STORAGE_KEY, String(width));
      } catch {
      }
    };
    const down = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      pointer = event.pointerId;
      handle.setPointerCapture?.(event.pointerId);
    };
    const move = (event) => {
      if (pointer === event.pointerId)
        resize(event.clientX - root.getBoundingClientRect().left);
    };
    const up = (event) => {
      if (pointer !== event.pointerId) return;
      pointer = null;
      if (handle.hasPointerCapture?.(event.pointerId))
        handle.releasePointerCapture(event.pointerId);
    };
    const key = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      const { min, max } = bounds();
      const current = Number(handle.getAttribute("aria-valuenow"));
      resize(
        event.key === "Home" ? min : event.key === "End" ? max : current + (event.key === "ArrowLeft" ? -16 : 16)
      );
    };
    handle.addEventListener("pointerdown", down);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
    handle.addEventListener("lostpointercapture", up);
    handle.addEventListener("keydown", key);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    observer?.observe(root);
    apply();
    return () => {
      observer?.disconnect();
      handle.removeEventListener("pointerdown", down);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      handle.removeEventListener("lostpointercapture", up);
      handle.removeEventListener("keydown", key);
    };
  };

  // frontend/runquery.ts
  var RUNQUERY_DEFAULT_MAX = 25;
  var RUNQUERY_MIN_MAX = 1;
  var clampMaxResults = (value) => {
    const num = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(num) || num <= 0) {
      return RUNQUERY_DEFAULT_MAX;
    }
    return Math.max(Math.trunc(num), RUNQUERY_MIN_MAX);
  };
  var commonDatasetPrefix = (names) => {
    if (names.length < 2) {
      return "";
    }
    let prefix = names[0];
    for (const name of names.slice(1)) {
      let at = 0;
      while (at < prefix.length && at < name.length && prefix[at] === name[at]) {
        at++;
      }
      prefix = prefix.slice(0, at);
      if (prefix.length === 0) {
        return "";
      }
    }
    const slash = prefix.lastIndexOf("/");
    if (slash < 0) {
      return "";
    }
    const folder = prefix.slice(0, slash + 1);
    return names.every((name) => name.length > folder.length) ? folder : "";
  };
  var runQueryPoolText = (total2, datasetCount, prefix = "") => {
    const prompts = `${total2.toLocaleString()} prompt${total2 === 1 ? "" : "s"}`;
    const datasets2 = `${datasetCount.toLocaleString()} dataset${datasetCount === 1 ? "" : "s"}`;
    const scope = prefix ? ` under ${prefix}` : "";
    return `${prompts} · ${datasets2}${scope}`;
  };
  var runQueryPreviewText = (shown, truncated) => {
    if (shown <= 0) {
      return "";
    }
    return truncated ? `${shown.toLocaleString()} sampled below` : `all ${shown.toLocaleString()} shown below`;
  };
  var summaryRow = (label, value) => `<div class="quarry-runquery-summary-row"><span class="quarry-runquery-summary-label">${label}</span><span class="quarry-runquery-summary-value">${escapeHtml(value)}</span></div>`;
  var renderRunQuerySummary = (total2, datasetCount, shown, truncated, prefix = "") => {
    const preview = runQueryPreviewText(shown, truncated);
    return `<div class="quarry-runquery-summary">${summaryRow(
      "Pool",
      runQueryPoolText(total2, datasetCount, prefix)
    )}${preview ? summaryRow("Preview", preview) : ""}</div>`;
  };
  var formatShare = (matches, total2) => {
    if (total2 <= 0 || matches <= 0) {
      return "";
    }
    const pct = matches / total2 * 100;
    return pct < 1 ? "<1%" : `${Math.round(pct)}%`;
  };
  var datasetRow = (dataset, prefix, total2, max) => {
    const shown = prefix ? dataset.name.slice(prefix.length) : dataset.name;
    const raw = max > 0 ? dataset.matches / max * 100 : 0;
    const width = raw > 0 ? Math.max(raw, 2) : 0;
    return `<div class="quarry-runquery-dataset-row"><span class="quarry-runquery-dataset-name" title="${escapeHtml(dataset.name)}">${escapeHtml(shown)}</span><span class="quarry-runquery-dataset-count">${dataset.matches.toLocaleString()}</span><span class="quarry-runquery-dataset-share">${escapeHtml(formatShare(dataset.matches, total2))}</span><span class="quarry-runquery-dataset-bar"><span style="width: ${width.toFixed(1)}%"></span></span></div>`;
  };
  var renderRunQueryDatasetCounts = (datasets2) => {
    if (!datasets2 || datasets2.length === 0) {
      return "";
    }
    const total2 = datasets2.reduce((sum, dataset) => sum + dataset.matches, 0);
    const max = datasets2.reduce(
      (best, dataset) => Math.max(best, dataset.matches),
      0
    );
    const prefix = commonDatasetPrefix(datasets2.map((dataset) => dataset.name));
    const rows = datasets2.map((dataset) => datasetRow(dataset, prefix, total2, max)).join("");
    return `<div class="quarry-runquery-datasets">${rows}</div>`;
  };
  var COPY_GLYPH = "&#x29C9;";
  var highlightPrompt = (prompt, highlights) => {
    const needles = (highlights ?? []).filter((term) => term.length > 0);
    if (needles.length === 0) {
      return escapeHtml(prompt);
    }
    const pattern = needles.slice().sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
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
  var groupResultsByDataset = (results) => {
    const groups = [];
    const indexOf = /* @__PURE__ */ new Map();
    for (const row of results) {
      let at = indexOf.get(row.dataset);
      if (at === void 0) {
        at = groups.length;
        indexOf.set(row.dataset, at);
        groups.push({ dataset: row.dataset, prompts: [] });
      }
      groups[at].prompts.push(row.prompt);
    }
    return groups;
  };
  var renderResultRow = (prompt, highlights, headingHtml = "") => `<tr><td class="quarry-runquery-result-prompt">${headingHtml}<div class="quarry-runquery-prompt-text">${highlightPrompt(prompt, highlights)}</div></td><td class="quarry-runquery-result-copy"><button type="button" class="basic-button quarry-runquery-copy" title="Copy prompt" aria-label="Copy prompt">${COPY_GLYPH}</button></td></tr>`;
  var renderResultTable = (rowsHtml) => `<table class="quarry-preview-table simple-table quarry-runquery-table"><colgroup><col class="quarry-runquery-col-prompt"><col class="quarry-runquery-col-copy"></colgroup><tbody>${rowsHtml}</tbody></table>`;
  var renderDatasetGroup = (dataset, prompts, highlights) => {
    const rows = prompts.map((prompt) => renderResultRow(prompt, highlights)).join("");
    return `<div class="quarry-runquery-dataset-group">
        <div class="quarry-runquery-dataset-heading">${escapeHtml(dataset)}</div>
        ${renderResultTable(rows)}
    </div>`;
  };
  var renderRunQueryResults = (results, highlights = []) => {
    if (!results || results.length === 0) {
      return `<div class="quarry-preview-empty">No matching rows.</div>`;
    }
    return groupResultsByDataset(results).map(
      (group) => renderDatasetGroup(group.dataset, group.prompts, highlights)
    ).join("");
  };
  var renderRunQueryResponse = (data) => {
    if (data.invalid) {
      return {
        summary: "",
        body: `<div class="quarry-runquery-invalid">${escapeHtml(data.invalid)}</div>`
      };
    }
    if (data.error) {
      return {
        summary: "",
        body: `<div class="quarry-preview-error">${escapeHtml(data.error)}</div>`
      };
    }
    const datasets2 = data.datasets ?? [];
    const results = data.results ?? [];
    return {
      summary: renderRunQuerySummary(
        data.total ?? 0,
        datasets2.length,
        results.length,
        data.truncated ?? false,
        commonDatasetPrefix(datasets2.map((dataset) => dataset.name))
      ),
      body: renderRunQueryDatasetCounts(datasets2) + (results.length === 0 && (data.total ?? 0) > 0 ? '<div class="quarry-preview-empty">Matching rows were counted, but no sample output was returned.</div>' : renderRunQueryResults(results, data.highlights ?? []))
    };
  };

  // frontend/explore.ts
  var textOperators = [
    ["=", "Contains any"],
    ["==", "Contains all"],
    ["!=", "Contains none"]
  ];
  var lengthOperators = [
    ["+=", "Length at least"],
    ["-=", "Length at most"]
  ];
  var isComparison = (operator) => operator === "+=" || operator === "-=";
  var numberOperators = [
    ["+=", "At least"],
    ["-=", "At most"]
  ];
  var isNumber = (column) => column?.kind === "scalar" && column.numeric === true;
  var canSuggestValue = (value) => value.trim().length > 0 && !/[,;[\]<>|]/.test(value);
  var quoteSeparator = (value) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  var buildExploreQuery = (dataset, filters, outputs = [], format = {}) => {
    const flags = [
      format.keys ? "keys" : "",
      format.recordSeparator !== void 0 && format.recordSeparator !== ", " ? `rs=${quoteSeparator(format.recordSeparator)}` : "",
      format.fieldSeparator !== void 0 && format.fieldSeparator !== ", " ? `fs=${quoteSeparator(format.fieldSeparator)}` : ""
    ].filter(Boolean);
    return `<q:${dataset}${filters.length ? `[${filters.map((filter) => `${filter.column}${filter.operator}${filter.values.join(",")}`).join(";")}]` : ""}${outputs.length ? `:${outputs.join(",")}` : ""}${flags.length ? `|${flags.join(";")}` : ""}>`;
  };
  var valueListSequence = 0;
  var buildDatasetQuery = (datasets2) => datasets2.some((dataset) => /[,;[\]<>|:*?]/.test(dataset.name)) ? null : buildExploreQuery(
    datasets2.map((dataset) => dataset.name).join(","),
    []
  );
  var DatasetExplorer = class {
    constructor(host, dataset, renderRows, close, newSample = () => {
    }, onViewChange = () => {
    }, availableDatasets = [dataset], onSourceChange = () => {
    }, mountDatasetSettings2, library = {}) {
      this.host = host;
      this.dataset = dataset;
      this.renderRows = renderRows;
      this.close = close;
      this.newSample = newSample;
      this.onViewChange = onViewChange;
      this.availableDatasets = availableDatasets;
      this.onSourceChange = onSourceChange;
      this.mountDatasetSettings = mountDatasetSettings2;
      this.library = library;
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
        this.element(".quarry-explore")
      );
      this.element(".quarry-explore-editor").append(
        this.element(".quarry-explore-format-panel")
      );
      host.addEventListener("click", this.click);
      document.addEventListener("click", this.outsideValues);
      document.addEventListener("focusin", this.outsideValues);
      window.addEventListener("resize", this.positionValues);
      host.addEventListener("scroll", this.positionValues, true);
      this.element(".quarry-explore-field").addEventListener(
        "scroll",
        this.scrollValues
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
    host;
    dataset;
    renderRows;
    close;
    newSample;
    onViewChange;
    availableDatasets;
    onSourceChange;
    mountDatasetSettings;
    library;
    valueListId = `quarry-values-${++valueListSequence}`;
    selected = 0;
    expandedView = "fields";
    queryTextMode = false;
    editingTag = false;
    queryTextDraft = null;
    sampleLimit = 100;
    resultsLimit = 100;
    overviewRequest = 0;
    overviewSource = "";
    filters = [];
    outputs = [];
    format = {};
    fields;
    datasets;
    drafts = /* @__PURE__ */ new Map();
    view = "fields";
    settingsDirty = false;
    datasetSearch = "";
    combine = false;
    disabledBrowseSelections = /* @__PURE__ */ new Set();
    expandedNamespaces = /* @__PURE__ */ new Set();
    openingNamespace;
    request = 0;
    draftQuery = "";
    resultsQuery = "";
    pendingQuery = null;
    openValueRow = null;
    disposed = false;
    valueRequest = 0;
    valueBusy = false;
    valueSearch = "";
    valueResponse = null;
    profiles = /* @__PURE__ */ new Map();
    valueMarkup = /* @__PURE__ */ new WeakMap();
    valueItems = [];
    searchTimer = null;
    splitterCleanup;
    settingsCleanup = null;
    dispose() {
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
        this.scrollValues
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
    get sourceName() {
      return this.dataset.name;
    }
    get elementHost() {
      return this.host;
    }
    selectDataset(name) {
      const dataset = this.availableDatasets.find(
        (item) => item.name === name
      );
      if (!dataset || dataset.error || !dataset.columns.length) return false;
      if (dataset.name !== this.dataset.name || this.datasets.length !== 1)
        this.updateDatasets([dataset], true, true);
      return this.dataset.name === name && this.datasets.length === 1;
    }
    showOverview() {
      if (this.view !== "overview") this.expandedView = this.view;
      this.setView("overview");
    }
    expand() {
      this.setView(this.expandedView);
      if (this.view === "rows") this.newSample();
      else if (this.view === "fields" && (this.resultsQuery !== this.draft().query || this.resultsLimit !== this.sampleLimit))
        this.testQuery();
    }
    setQueryMode(text, query, editing = text) {
      if (text && !this.queryTextMode)
        this.queryTextDraft = query ?? this.draft().query;
      this.queryTextMode = text;
      this.editingTag = editing;
      this.closeAuxiliaryPanels();
      this.element(".quarry-explore-editor").disabled = text;
      this.element(".quarry-query-text-input").value = this.queryTextDraft ?? "";
      this.element(".quarry-explore-scope").hidden = text && this.view === "fields";
      this.renderTagEditor();
      this.renderDraft();
      if (text && editing)
        this.element(
          ".quarry-query-text-input"
        ).focus();
      else if (!text) this.selectRow(this.selected);
    }
    renderTagEditor() {
      this.element(".quarry-query-text").hidden = !this.editingTag;
      this.element(".quarry-explore-query").hidden = this.editingTag;
      this.element('[data-action="edit-tag"]').hidden = this.editingTag;
      this.element('[data-action="done-tag"]').hidden = !this.editingTag;
      this.element('[data-action="use-builder"]').hidden = !this.queryTextMode;
    }
    refreshMetadata() {
      this.renderRail();
      this.renderOverviewMetadata();
    }
    updateCatalog(datasets2) {
      this.availableDatasets = datasets2;
      this.dataset = datasets2.find((item) => item.name === this.dataset.name) ?? this.dataset;
      this.datasets = this.datasets.map(
        (selected) => datasets2.find(
          (item) => item.name === selected.name && !item.error && item.columns.length
        )
      ).filter((item) => !!item);
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
    renderOverviewMetadata() {
      const single = this.datasets.length === 1;
      const columns = single ? this.dataset.columns : sharedExploreColumns(this.datasets);
      const rows = this.datasets.every((dataset) => dataset.rowCount != null) ? `${this.datasets.reduce((total2, dataset) => total2 + (dataset.rowCount ?? 0), 0).toLocaleString()} rows` : "Rows unknown";
      this.element(".quarry-library-title").innerHTML = this.datasets.map(
        (dataset) => `<button type="button" class="quarry-dataset-name quarry-dataset-name-link" data-prompt-dataset="${escapeHtml(dataset.name)}" title="Add or remove this dataset in the prompt"${buildDatasetQuery([dataset]) ? "" : " disabled"}>${escapeHtml(dataset.name)}</button>`
      ).join(", ");
      this.element(
        '[data-action="use-overview"]'
      ).disabled = !buildDatasetQuery(this.datasets);
      this.element(".quarry-library-metadata").innerHTML = `<div class="quarry-library-facts"><span>${rows}</span><span>${single ? "Columns" : "Shared columns"}: ${columns.map((column) => escapeHtml(column.name)).join(", ") || "—"}</span></div>${single && this.library.renderWildcardToggle ? `<div class="quarry-library-wildcard">${this.library.renderWildcardToggle(this.dataset)}<span>Include in wildcards</span></div>` : ""}`;
    }
    loadOverview(refresh2 = false) {
      this.renderOverviewMetadata();
      const query = buildDatasetQuery(this.datasets);
      if (!query) {
        this.overviewRequest++;
        this.overviewSource = "";
        this.element(".quarry-library-sample").textContent = "Open Explore to write a query for this dataset.";
        return;
      }
      if (!refresh2 && this.overviewSource === query) return;
      this.overviewSource = query;
      const request2 = ++this.overviewRequest;
      const region = this.element(".quarry-library-sample");
      region.textContent = "Loading sample…";
      genericRequest(
        "QuarryRunQuery",
        { query, maxResults: 10 },
        (data) => {
          if (this.disposed || request2 !== this.overviewRequest) return;
          if (data.error || data.invalid) {
            region.textContent = data.error || data.invalid || "Could not load sample.";
            this.overviewSource = "";
          } else {
            const rows = data.results ?? [];
            region.innerHTML = this.datasets.length === 1 && rows.length ? renderResultTable(
              rows.map(
                (row) => renderResultRow(
                  row.prompt,
                  data.highlights ?? []
                )
              ).join("")
            ) : renderRunQueryResults(
              rows,
              data.highlights ?? []
            );
          }
        },
        0,
        () => {
          if (this.disposed || request2 !== this.overviewRequest) return;
          region.textContent = "Could not load sample. Select the dataset again to retry.";
          this.overviewSource = "";
        }
      );
    }
    setView(view) {
      const previous = this.view;
      this.view = view;
      this.element(".quarry-explore-scope").hidden = this.queryTextMode && view === "fields";
      this.element(".quarry-explore").classList.toggle(
        "quarry-library-compact",
        view === "overview"
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
      this.element(".quarry-explore-settings-view").hidden = view !== "settings";
      this.element(".quarry-explore-rows").hidden = view !== "rows";
      this.element(".quarry-explore-rows-view").hidden = view !== "rows";
      this.host.querySelectorAll("[data-view]").forEach((tab) => {
        tab.setAttribute(
          "aria-pressed",
          String(tab.dataset.view === view)
        );
        tab.setAttribute(
          "aria-selected",
          String(tab.dataset.view === view)
        );
        tab.tabIndex = tab.dataset.view === view ? 0 : -1;
      });
    }
    setRows(columns, rows) {
      const region = this.element(".quarry-explore-rows");
      region.innerHTML = this.renderRows(columns, rows);
      const table = region.querySelector("table");
      if (table?.tHead) {
        const widths = columns.map(
          (name, index) => Math.max(
            80,
            Math.min(
              360,
              Math.max(
                name.length,
                ...rows.map((row) => (row[index] ?? "").length)
              ) * 7 + 24
            )
          )
        );
        const width = widths.reduce((sum, value) => sum + value, 0);
        const colgroup = `<colgroup>${widths.map((width2) => `<col style="width:${width2}px">`).join("")}</colgroup>`;
        table.insertAdjacentHTML("afterbegin", colgroup);
        table.style.width = `max(100%, ${width}px)`;
        const header = document.createElement("div");
        header.className = "quarry-explore-table-header";
        header.setAttribute("aria-hidden", "true");
        const headerTable = table.cloneNode(false);
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
    renderScope(resetSettings = true) {
      this.expandedNamespaces.add(this.namespace(this.dataset.name));
      this.renderRail(true);
      this.element(".quarry-explore-scope").innerHTML = this.datasets.map(
        (dataset) => `<span class="quarry-explore-dataset-chip"><span>${escapeHtml(dataset.name)}</span>${this.datasets.length > 1 ? `<button type="button" class="basic-button" data-remove-dataset="${escapeHtml(dataset.name)}" aria-label="Remove dataset ${escapeHtml(dataset.name)}">×</button>` : ""}</span>`
      ).join("");
      const source = this.element(".quarry-explore-source");
      source.hidden = this.datasets.length < 2;
      source.innerHTML = this.sourceSelector("Show rows from");
      const settingsSource = this.element(".quarry-explore-settings-source");
      settingsSource.hidden = this.datasets.length < 2;
      settingsSource.innerHTML = this.sourceSelector("Settings for");
      if (!resetSettings) return;
      this.settingsCleanup?.();
      this.settingsDirty = false;
      this.element('[data-view="settings"]').hidden = !this.mountDatasetSettings;
      this.settingsCleanup = this.mountDatasetSettings?.(
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
        }
      ) ?? null;
    }
    namespace(name) {
      const slash = name.indexOf("/");
      return slash < 0 ? "" : name.slice(0, slash + 1);
    }
    railDatasets() {
      const namespace = this.namespace(this.dataset.name);
      return this.availableDatasets.filter(
        (dataset) => this.namespace(dataset.name) === namespace && !dataset.error && dataset.columns.length > 0 && (dataset.enabled !== false || this.disabledBrowseSelections.has(dataset.name) || dataset.name === this.dataset.name)
      ).sort((a, b) => a.name.localeCompare(b.name));
    }
    usedColumns() {
      return [
        ...this.filters.filter((row) => row.value.trim()).map((row) => row.column),
        ...this.outputs
      ];
    }
    renderRail(revealCurrent = false) {
      const list = this.element(".quarry-explore-rail-list");
      const scroll = list.scrollTop;
      const textScope = this.queryTextMode && this.view !== "overview";
      const search = this.datasetSearch.trim().toLowerCase();
      const groups = /* @__PURE__ */ new Map();
      for (const dataset of [...this.availableDatasets].sort(
        (a, b) => a.name.localeCompare(b.name)
      )) {
        const namespace = this.namespace(dataset.name);
        if (!groups.has(namespace)) groups.set(namespace, []);
        groups.get(namespace)?.push(dataset);
      }
      const used = this.usedColumns();
      const selectedNames = new Set(
        this.datasets.map((dataset) => dataset.name)
      );
      list.innerHTML = [...groups].sort(
        ([a], [b]) => Number(b === this.openingNamespace) - Number(a === this.openingNamespace) || a.localeCompare(b)
      ).map(([namespace, datasets3], groupIndex) => {
        const matches = datasets3.filter(
          (dataset) => dataset.name.toLowerCase().includes(search)
        );
        if (!matches.length) return "";
        const selected = datasets3.filter(
          (dataset) => selectedNames.has(dataset.name)
        ).length;
        const open = !!search || this.expandedNamespaces.has(namespace);
        const groupId = `quarry-explore-namespace-${groupIndex}`;
        const rows = matches.map((dataset, rowIndex) => {
          const name = escapeHtml(dataset.name);
          const label = escapeHtml(
            dataset.name.slice(namespace.length)
          );
          const included = selectedNames.has(dataset.name);
          const disabled = dataset.enabled === false;
          const unavailable = dataset.error || (!dataset.columns.length ? "Dataset has no available fields." : "");
          const reason = this.combine && this.view !== "overview" ? included ? "" : datasetCompatibility(
            dataset,
            this.fields,
            used
          ) : unavailable;
          const locked = included && this.datasets.length === 1;
          const reasonId = `${groupId}-reason-${rowIndex}`;
          const metadata = [
            dataset.rowCount == null ? "Rows unknown" : `${dataset.rowCount.toLocaleString()} rows`,
            ...dataset.columns.filter(
              (column) => column.name.toLowerCase() !== "prompt"
            ).map((column) => column.name),
            ...disabled ? ["Wildcards off"] : []
          ].join(" · ");
          const content = `<span>${label}<small class="quarry-explore-dataset-metadata">${escapeHtml(metadata)}</small></span>`;
          const control = this.combine && this.view !== "overview" ? `<label class="quarry-explore-dataset-choice ${included ? "is-selected" : ""}"><input type="checkbox" data-include-dataset="${name}" aria-label="Include ${name} in query" ${included ? "checked" : ""} ${reason || locked || textScope ? "disabled" : ""} ${reason ? `aria-describedby="${reasonId}"` : ""}>${content}</label>` : `<button type="button" class="basic-button" data-browse-dataset="${name}" aria-current="${dataset.name === this.dataset.name}" ${unavailable ? `disabled aria-describedby="${reasonId}"` : ""}>${content}</button>`;
          return `<div class="quarry-explore-rail-row${disabled ? " is-disabled-dataset" : ""}"${disabled ? ' title="Excluded from wildcards. You can still select this dataset explicitly."' : ""}>${control}${reason ? `<small id="${reasonId}">${escapeHtml(reason)}</small>` : ""}</div>`;
        }).join("");
        return `<section class="quarry-explore-namespace"><button type="button" class="quarry-explore-namespace-toggle" data-namespace="${escapeHtml(namespace)}" aria-expanded="${open}" aria-controls="${groupId}"><span>${escapeHtml(namespace ? namespace.slice(0, -1) : "Root")}</span><small>${search ? `${matches.length} of ` : ""}${datasets3.length} datasets${selected ? ` · ${selected} selected` : ""}</small></button><div id="${groupId}" class="quarry-explore-namespace-items" ${open ? "" : "hidden"}>${rows}</div></section>`;
      }).join("") || '<p class="quarry-explore-note">No datasets match.</p>';
      list.scrollTop = scroll;
      const datasets2 = this.railDatasets();
      const index = datasets2.findIndex(
        (item) => item.name === this.dataset.name
      );
      const combined = this.datasets.length > 1;
      this.host.querySelectorAll("[data-dataset-mode]").forEach((button) => {
        button.disabled = textScope && button.dataset.datasetMode === "combine";
        button.setAttribute(
          "aria-pressed",
          String(
            button.dataset.datasetMode === "combine" === this.combine
          )
        );
      });
      const position = this.element(".quarry-explore-rail-position");
      position.textContent = textScope ? "Query text controls dataset scope." : combined ? `${this.datasets.length} selected. Choose one in Browse to use it alone.` : "";
      position.hidden = !position.textContent;
      this.element(
        '[data-action="previous-dataset"]'
      ).disabled = combined || this.combine && this.view !== "overview" || index <= 0;
      this.element(
        '[data-action="next-dataset"]'
      ).disabled = combined || this.combine && this.view !== "overview" || index < 0 || index === datasets2.length - 1;
      if (revealCurrent && !search) {
        const current = list.querySelector(
          '[data-browse-dataset][aria-current="true"]'
        );
        if (current) {
          const header = current.closest(".quarry-explore-namespace")?.querySelector(".quarry-explore-namespace-toggle");
          const bounds = list.getBoundingClientRect();
          const card = current.getBoundingClientRect();
          const top = bounds.top + (header?.getBoundingClientRect().height ?? 0);
          if (card.top < top) list.scrollTop += card.top - top;
          else if (card.bottom > bounds.bottom)
            list.scrollTop += card.bottom - bounds.bottom;
        }
      }
    }
    confirmSettingsChange() {
      return !this.settingsDirty || window.confirm(
        "Discard unsaved dataset settings and switch datasets?"
      );
    }
    sourceSelector(label) {
      return `<label>${label}<select class="auto-dropdown quarry-explore-source-select" aria-label="${label}">${this.datasets.map((dataset) => `<option value="${escapeHtml(dataset.name)}" ${dataset.name === this.dataset.name ? "selected" : ""}>${escapeHtml(dataset.name)}</option>`).join("")}</select></label>`;
    }
    chooseDatasets() {
      this.closeAuxiliaryPanels();
      this.element(
        ".quarry-explore-dataset-search"
      ).focus();
    }
    updateDatasets(datasets2, reset, browse = false) {
      if (!this.confirmSettingsChange()) return;
      const previous = this.dataset.name;
      if (!reset) {
        for (const dataset of datasets2) {
          if (dataset.enabled === false && !this.datasets.some((item) => item.name === dataset.name))
            this.disabledBrowseSelections.add(dataset.name);
        }
        for (const dataset of this.datasets) {
          if (!datasets2.some((item) => item.name === dataset.name))
            this.disabledBrowseSelections.delete(dataset.name);
        }
      }
      const key = (sources) => JSON.stringify(sources.map((source) => source.name).sort());
      this.drafts.set(key(this.datasets), {
        queryText: this.queryTextMode ? this.queryTextDraft ?? "" : void 0,
        editingTag: this.editingTag,
        filters: this.filters.map((filter) => ({ ...filter })),
        outputs: [...this.outputs],
        format: { ...this.format }
      });
      if (this.queryTextMode) this.setQueryMode(false);
      this.datasets = datasets2;
      this.dataset = datasets2.find((dataset) => dataset.name === previous) ?? datasets2[0];
      this.fields = sharedExploreColumns(datasets2);
      const saved = this.drafts.get(key(datasets2));
      const draft = reset && browse || saved?.queryText !== void 0 ? saved : void 0;
      if (reset || draft) {
        this.filters = draft?.filters.map((filter) => ({ ...filter })) ?? [
          this.blankFilter()
        ];
        this.outputs = draft ? [...draft.outputs] : [];
        this.format = { ...draft?.format };
        this.element(".quarry-explore-keys").checked = !!this.format.keys;
        this.element(
          ".quarry-explore-record-separator"
        ).value = this.format.recordSeparator ?? ", ";
        this.element(
          ".quarry-explore-field-separator"
        ).value = this.format.fieldSeparator ?? ", ";
        this.closeAuxiliaryPanels();
        this.element(".quarry-explore-format-panel").hidden = true;
        this.element('[data-action="format"]').setAttribute(
          "aria-expanded",
          "false"
        );
      } else {
        this.filters = this.filters.map((row) => {
          const field = this.fields.find(
            (field2) => field2.name.toLowerCase() === row.column.toLowerCase()
          );
          return field ? { ...row, column: field.name } : this.blankFilter();
        });
        this.outputs = this.outputs.map(
          (name) => this.fields.find(
            (field) => field.name.toLowerCase() === name.toLowerCase()
          )?.name ?? name
        );
      }
      this.selected = Math.min(this.selected, this.filters.length - 1);
      this.resultsQuery = "";
      this.element(".quarry-explore-results").replaceChildren();
      if (previous !== this.dataset.name) {
        this.element(".quarry-explore-rows").textContent = "Loading dataset rows…";
      }
      this.renderScope();
      this.renderFilters();
      this.renderOutput();
      this.renderFormatExamples();
      this.selectRow(this.selected);
      if (saved?.queryText !== void 0)
        this.setQueryMode(true, saved.queryText, saved.editingTag);
      this.renderDraft();
      this.setView(browse ? this.view : "fields");
      this.onSourceChange(
        this.dataset,
        datasets2.map((dataset) => dataset.name)
      );
      if (this.view !== "overview") this.testQuery();
    }
    changeSource(name) {
      const dataset = this.datasets.find((dataset2) => dataset2.name === name);
      if (!dataset || dataset.name === this.dataset.name) return;
      if (!this.confirmSettingsChange()) {
        this.host.querySelectorAll(
          ".quarry-explore-source-select"
        ).forEach((select) => {
          select.value = this.dataset.name;
        });
        return;
      }
      this.dataset = dataset;
      this.renderScope();
      this.element(".quarry-explore-rows").textContent = "Loading dataset rows…";
      this.selectRow(this.selected);
      this.onSourceChange(
        dataset,
        this.datasets.map((selected) => selected.name)
      );
    }
    renderResults(data) {
      const results = this.element(".quarry-explore-results");
      if (data.error || data.invalid) {
        results.innerHTML = `<p class="quarry-preview-error">${escapeHtml(data.error ?? data.invalid ?? "Query failed.")}</p>`;
        return;
      }
      const rows = data.results ?? [];
      const total2 = data.total ?? 0;
      const breakdown = this.datasets.length > 1 && data.datasets?.length ? `<details><summary>Matches by dataset</summary>${data.datasets.map((dataset) => `<div>${escapeHtml(dataset.name)} · ${dataset.matches.toLocaleString()} matches</div>`).join("")}</details>` : "";
      const multiple = this.datasets.length > 1;
      const table = rows.length ? renderResultTable(
        rows.map(
          (row) => renderResultRow(
            row.prompt,
            data.highlights ?? [],
            multiple ? `<button type="button" class="quarry-explore-query-dataset quarry-explore-result-source" data-action="choose-datasets">${escapeHtml(row.dataset)}</button>` : ""
          )
        ).join("")
      ) : `<p class="quarry-preview-empty">${total2 > 0 ? "Matching rows were counted, but no sample output was returned." : "No matching rows."}</p>`;
      results.innerHTML = `<div class="quarry-explore-result-summary"><h6>Results</h6><span>${rows.length.toLocaleString()} random result${rows.length === 1 ? "" : "s"} · ${total2.toLocaleString()} matches</span>${breakdown}</div><div class="quarry-explore-result-heading">${multiple ? `${this.datasets.length} datasets` : `<button type="button" class="quarry-explore-query-dataset" data-action="choose-datasets" title="Switch dataset or add another dataset">${escapeHtml(this.dataset.name)}</button>`}</div><div class="quarry-explore-result-scroll" tabindex="0" role="region" aria-label="Query results">${table}</div>`;
    }
    closeAuxiliaryPanels() {
      this.element(".quarry-explore-field").hidden = true;
      this.openValueRow = null;
      this.host.querySelectorAll(
        "[aria-expanded][data-values-row], .quarry-explore-value[aria-expanded]"
      ).forEach((button) => {
        button.setAttribute("aria-expanded", "false");
      });
    }
    renderFormatExamples() {
      const keys = this.format.keys;
      this.element(".quarry-explore-record-example").textContent = [
        keys ? "prompt: portrait" : "portrait",
        keys ? "style: watercolor" : "watercolor"
      ].join(this.format.recordSeparator ?? ", ");
      this.element(".quarry-explore-field-example").textContent = [
        keys ? "hair: blonde" : "blonde",
        keys ? "expression: smiling" : "smiling"
      ].join(this.format.fieldSeparator ?? ", ");
    }
    renderQuerySuffix(suffix) {
      if (!this.outputs.length) return escapeHtml(suffix);
      const start = suffix.startsWith("[") ? suffix.indexOf("]") + 1 : 0;
      const tokens = this.outputs.map(
        (name, index) => `<span class="quarry-explore-output-token" data-output-index="${index}" draggable="true" tabindex="0" title="Drag to reorder. Alt+Left/Right also moves this column."><span class="quarry-output-grip" aria-hidden="true"></span>${escapeHtml(name)}<button type="button" class="quarry-output-remove" data-remove-output="${index}" aria-label="Remove output ${escapeHtml(name)}"></button></span>`
      ).join(",");
      return escapeHtml(suffix.slice(0, start + 1)) + tokens + escapeHtml(suffix.slice(start + 1 + this.outputs.join(",").length));
    }
    moveOutput(from, to) {
      if (!Number.isInteger(from) || !Number.isInteger(to) || from === to || from < 0 || to < 0 || from >= this.outputs.length || to >= this.outputs.length)
        return;
      const [column] = this.outputs.splice(from, 1);
      this.outputs.splice(to, 0, column);
      this.renderOutput();
      this.renderDraft();
      this.element(`[data-output-index="${to}"]`).focus();
    }
    dragstart = (event) => {
      const token = event.target.closest(
        "[data-output-index]"
      );
      if (token && event.dataTransfer) {
        event.dataTransfer.setData(
          "application/x-quarry-output",
          token.dataset.outputIndex ?? ""
        );
        event.dataTransfer.effectAllowed = "move";
      }
    };
    clearDropMarker = () => {
      this.host.querySelectorAll("[data-drop-edge]").forEach((token) => {
        token.removeAttribute("data-drop-edge");
      });
    };
    dragleave = (event) => {
      const token = event.target.closest(
        "[data-output-index]"
      );
      if (token && !token.contains(event.relatedTarget))
        this.clearDropMarker();
    };
    dragover = (event) => {
      const token = event.target.closest(
        "[data-output-index]"
      );
      if (!token || !event.dataTransfer?.types.includes("application/x-quarry-output"))
        return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      this.clearDropMarker();
      const rect = token.getBoundingClientRect();
      token.dataset.dropEdge = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
    };
    drop = (event) => {
      const token = event.target.closest(
        "[data-output-index]"
      );
      const source = event.dataTransfer?.getData(
        "application/x-quarry-output"
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
    keydown = (event) => {
      const target = event.target;
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && this.view === "fields") {
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
      if (valueInput && event.key === "Enter" && this.profile(this.filters[this.selected])?.eligible) {
        event.preventDefault();
        this.commitTerm();
        this.valueSearch = "";
        if (this.searchTimer) clearTimeout(this.searchTimer);
        this.loadValues();
        return;
      }
      if ((valueInput || inValues) && this.profile(this.filters[this.selected])?.eligible && !this.smallValues(this.filters[this.selected]).length && ["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        this.openValues();
        const options = Array.from(
          this.element(
            ".quarry-explore-field"
          ).querySelectorAll("button:not(:disabled)")
        );
        const index = options.indexOf(target);
        options[(index < 0 ? event.key === "ArrowDown" ? 0 : options.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
        return;
      }
      if (event.key === "Escape" && this.openValueRow !== null) {
        event.preventDefault();
        event.stopPropagation();
        this.element(
          `[data-row="${this.selected}"] .quarry-explore-value`
        ).focus();
        this.closeAuxiliaryPanels();
        return;
      }
      const token = target.closest("[data-output-index]");
      if (token && event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        const from = Number(token.dataset.outputIndex);
        this.moveOutput(from, from + (event.key === "ArrowLeft" ? -1 : 1));
        return;
      }
      if (event.key === "Escape" && target.matches(".quarry-explore-dataset-search") && this.datasetSearch) {
        event.preventDefault();
        event.stopPropagation();
        this.datasetSearch = "";
        target.value = "";
        this.renderRail();
        return;
      }
      if (event.key === "Escape" && !this.element(".quarry-explore-format-panel").hidden) {
        event.preventDefault();
        event.stopPropagation();
        this.element(".quarry-explore-format-panel").hidden = true;
        this.element('[data-action="format"]').setAttribute(
          "aria-expanded",
          "false"
        );
        this.element('[data-action="format"]').focus();
        return;
      }
      if (target.matches("[data-view]") && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const views = Array.from(
          this.host.querySelectorAll("[data-view]")
        ).filter((tab2) => !tab2.hidden).map((tab2) => tab2.dataset.view);
        const index = views.indexOf(target.dataset.view ?? "fields");
        const view = event.key === "Home" ? views[0] : event.key === "End" ? views[views.length - 1] : views[(index + (event.key === "ArrowRight" ? 1 : -1) + views.length) % views.length];
        const tab = this.element(
          `[data-view="${view}"]`
        );
        tab.focus();
        tab.click();
      }
    };
    element(selector) {
      const element = this.host.querySelector(selector);
      if (!element) throw new Error(`Missing Explore control: ${selector}`);
      return element;
    }
    blankFilter() {
      const column = this.fields[0];
      return {
        column: column?.name ?? "",
        operator: isNumber(column) ? "+=" : "=",
        value: ""
      };
    }
    activeColumn() {
      return this.fields.find(
        (column) => column.name === this.filters[this.selected]?.column
      );
    }
    renderFilters() {
      this.filters = this.filters.map((filter) => {
        const column = this.fields.find(
          (field) => field.name.toLowerCase() === filter.column.toLowerCase()
        );
        return column ? { ...filter, column: column.name } : filter.value.trim() || filter.term?.trim() ? filter : this.blankFilter();
      });
      this.element('[data-action="add"]').disabled = !this.fields.length;
      this.element(".quarry-explore-filters").innerHTML = this.filters.map((filter, index) => {
        const column = this.fields.find(
          (field) => field.name === filter.column
        );
        const operators = isNumber(column) ? numberOperators : column?.kind === "scalar" ? [...textOperators, ...lengthOperators] : textOperators;
        const numericInput = isNumber(column) || isComparison(filter.operator);
        return `<div class="quarry-explore-filter-row ${index === this.selected ? "active" : ""}" data-row="${index}">
                <select class="quarry-explore-column auto-dropdown" aria-label="Field ${index + 1}">${column ? "" : `<option value="${escapeHtml(filter.column)}" selected disabled>${escapeHtml(filter.column)} (unavailable)</option>`}${this.fields.map((field) => `<option value="${escapeHtml(field.name)}" ${field.name === filter.column ? "selected" : ""}>${escapeHtml(field.name)}</option>`).join("")}</select>
                <select class="quarry-explore-operator auto-dropdown" aria-label="Match ${index + 1}">${operators.map(([value, label]) => `<option value="${value}" ${value === filter.operator ? "selected" : ""}>${label}</option>`).join("")}</select>
                <div class="quarry-explore-value-control"><div class="quarry-explore-inline-values" hidden></div><div class="quarry-explore-terms"></div><input ${column ? "" : "disabled"} class="quarry-explore-value auto-text" aria-label="Value ${index + 1}" type="${numericInput ? "number" : "text"}" ${numericInput ? isNumber(column) ? 'step="any"' : 'step="1" min="0"' : ""} placeholder="${isNumber(column) ? "Number" : numericInput ? "Character count" : "Search terms"}" value="${escapeHtml(filter.value)}">
                <button type="button" class="basic-button quarry-explore-values-toggle" data-values-row="${index}" aria-expanded="false" hidden aria-label="Value suggestions">⌄</button></div>
                <button type="button" class="basic-button" data-remove="${index}" ${this.filters.length === 1 ? "hidden" : ""} aria-label="Remove filter ${index + 1}">×</button>
            </div>`;
      }).join("");
      this.updateValueInputs();
    }
    profile(row) {
      return isComparison(row.operator) ? void 0 : this.profiles.get(`${this.dataset.name}:${row.column}`);
    }
    smallValues(row) {
      const profile = this.profile(row);
      const values = [
        ...new Set((profile?.values ?? []).map((value) => value.trim()))
      ];
      return profile?.eligible && !profile.hasMore && (profile.totalValues ?? values.length) <= 6 && values.every(
        (value) => value.length <= 12 && canSuggestValue(value)
      ) ? values : [];
    }
    updateValueMarkup(element, markup) {
      if (this.valueMarkup.get(element) === markup) return;
      element.innerHTML = markup;
      this.valueMarkup.set(element, markup);
    }
    updateValueInputs() {
      this.filters.forEach((filter, index) => {
        const selector = `[data-row="${index}"]`;
        const profile = this.profile(filter);
        const adaptive = !!profile?.eligible;
        const small = this.smallValues(filter);
        const chosen = this.values(filter.value);
        const input = this.element(
          `${selector} .quarry-explore-value`
        );
        const control = this.element(
          `${selector} .quarry-explore-value-control`
        );
        control.classList.toggle("adaptive", adaptive);
        const terms = this.element(
          `${selector} .quarry-explore-terms`
        );
        const termsHtml = adaptive ? chosen.filter((value) => !small.includes(value)).map(
          (value) => `<button type="button" class="quarry-explore-term" data-remove-term="${escapeHtml(value)}" aria-label="Remove ${escapeHtml(value)}">${escapeHtml(value)}<span aria-hidden="true">×</span></button>`
        ).join("") : "";
        this.updateValueMarkup(terms, termsHtml);
        const chips = this.element(
          `${selector} .quarry-explore-inline-values`
        );
        const focusedValue = chips.contains(document.activeElement) ? document.activeElement.dataset.value : void 0;
        const chipsHtml = small.map(
          (value) => `<button type="button" class="basic-button" data-value="${escapeHtml(value)}" aria-pressed="${chosen.includes(value)}">${escapeHtml(value)}</button>`
        ).join("");
        this.updateValueMarkup(chips, chipsHtml);
        if (focusedValue !== void 0)
          Array.from(
            chips.querySelectorAll("[data-value]")
          ).find((button2) => button2.dataset.value === focusedValue)?.focus({ preventScroll: true });
        chips.hidden = !small.length;
        const text = adaptive ? filter.term ?? "" : filter.value;
        if (input.value !== text) input.value = text;
        if (!isComparison(filter.operator))
          input.placeholder = adaptive ? small.length ? "Or type a term…" : "Type or select…" : "Search terms";
        const expanded = index === this.openValueRow;
        input.setAttribute("aria-expanded", String(expanded));
        if (adaptive && !small.length) {
          input.setAttribute("aria-controls", this.valueListId);
        } else {
          input.removeAttribute("aria-controls");
          input.removeAttribute("aria-expanded");
        }
        const button = this.element(
          `${selector} [data-values-row]`
        );
        button.hidden = !(adaptive && !small.length) && profile?.success !== false;
        button.textContent = profile?.success === false ? "↻" : "⌄";
        button.setAttribute(
          "aria-label",
          profile?.success === false ? "Retry value suggestions" : `Suggestions for ${filter.column}`
        );
        button.setAttribute("aria-expanded", String(expanded));
      });
    }
    commitTerm(index = this.selected) {
      const row = this.filters[index];
      if (!row?.term) return;
      row.value = [
        .../* @__PURE__ */ new Set([...this.values(row.value), ...this.values(row.term)])
      ].join(", ");
      row.term = "";
      this.updateValueInputs();
      this.renderDraft();
    }
    selectRow(index) {
      this.commitTerm();
      this.closeAuxiliaryPanels();
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.selected = index;
      this.host.querySelectorAll("[data-row]").forEach((row) => {
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
    renderDiscovery() {
      this.element(".quarry-explore-field").innerHTML = `${this.datasets.length > 1 ? `<div class="quarry-explore-value-source">${this.sourceSelector("Suggestions from")}</div>` : ""}<div class="quarry-explore-suggestions" role="group" aria-label="Suggested search terms" id="${this.valueListId}"></div>`;
      this.renderSuggestions();
    }
    openValues() {
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
    positionValues = () => {
      if (this.openValueRow === null) return;
      const control = this.element(
        `[data-row="${this.openValueRow}"] .quarry-explore-value-control`
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
      pane.style.bottom = upwards ? `${window.innerHeight - rect.top + 4}px` : "auto";
    };
    outsideValues = (event) => {
      const path = event.composedPath();
      if (path.includes(this.element(".quarry-explore-field")) || path.some(
        (item) => item instanceof Element && item.matches(".quarry-explore-value-control")
      ))
        return;
      if (event.type === "click") this.commitTerm();
      this.closeAuxiliaryPanels();
    };
    scrollValues = (event) => {
      if (event.target !== this.element(".quarry-explore-field")) return;
      const pane = event.target;
      if (!this.valueBusy && this.valueResponse?.hasMore && pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 40)
        this.loadValues(true);
    };
    renderOutput() {
      this.element(
        ".quarry-explore-output-add"
      ).innerHTML = '<option value="">Add column…</option>' + this.fields.filter((column) => !this.outputs.includes(column.name)).map(
        (column) => `<option value="${escapeHtml(column.name)}">${escapeHtml(column.name)}</option>`
      ).join("");
      this.element(".quarry-explore-output-selected").textContent = this.outputs.length ? this.outputs.length > 1 ? "Drag column tags in the query to reorder." : "" : `Dataset default: ${this.datasets.length === 1 ? this.dataset.resolvedPromptColumn ?? "first available column" : "each dataset’s default output"}`;
    }
    focus = (event) => {
      const row = event.target.closest(
        "[data-row]"
      );
      if (row && Number(row.dataset.row) !== this.selected)
        this.selectRow(Number(row.dataset.row));
      if (event.target.matches(".quarry-explore-value"))
        this.openValues();
    };
    edit = (event) => {
      const target = event.target;
      if (target.dataset.includeDataset !== void 0) {
        if (event.type !== "change" || target.disabled || !this.combine)
          return;
        this.commitTerm();
        const name = target.dataset.includeDataset;
        const dataset = this.availableDatasets.find(
          (item) => item.name === name
        );
        if (!dataset) return;
        if (target.checked) {
          if (this.datasets.some((item) => item.name === name) || datasetCompatibility(
            dataset,
            this.fields,
            this.usedColumns()
          ))
            return;
          this.updateDatasets([...this.datasets, dataset], false);
        } else if (this.datasets.length > 1) {
          this.updateDatasets(
            this.datasets.filter((item) => item.name !== name),
            false
          );
        }
        this.renderRail();
        [
          ...this.host.querySelectorAll(
            "[data-include-dataset]"
          )
        ].find((input) => input.dataset.includeDataset === name)?.focus({ preventScroll: true });
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
      const row = target.closest("[data-row]");
      if (row) {
        const index = Number(row.dataset.row);
        const filter = this.filters[index];
        if (target.matches(".quarry-explore-column")) {
          if (event.type !== "change") return;
          filter.column = target.value;
          filter.operator = isNumber(
            this.fields.find((field) => field.name === filter.column)
          ) ? "+=" : "=";
          filter.value = "";
          filter.term = "";
          this.closeAuxiliaryPanels();
          this.renderFilters();
          this.selectRow(index);
          this.element(
            `[data-row="${index}"] .quarry-explore-column`
          ).focus();
        } else if (target.matches(".quarry-explore-operator")) {
          if (event.type !== "change") return;
          this.commitTerm(index);
          const changedType = isComparison(filter.operator) !== isComparison(target.value);
          filter.operator = target.value;
          if (changedType) {
            filter.value = "";
            filter.term = "";
            this.closeAuxiliaryPanels();
          }
          this.renderFilters();
          if (changedType && !isComparison(filter.operator))
            this.loadValues();
          this.element(
            `[data-row="${index}"] .quarry-explore-operator`
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
                250
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
    loadValues(append = false) {
      if (this.view !== "fields" || this.queryTextMode) return;
      const column = this.activeColumn();
      if (!column || isNumber(column) || isComparison(this.filters[this.selected].operator) || column.kind !== "scalar" || !this.dataset.columns.some(
        (source) => source.name.toLowerCase() === column.name.toLowerCase()
      ))
        return;
      const request2 = ++this.valueRequest;
      const search = this.valueSearch;
      const offset = append ? this.valueItems.length : 0;
      this.valueBusy = true;
      this.renderSuggestions();
      const receive = (data) => {
        if (this.disposed || request2 !== this.valueRequest) return;
        if (append && data.success && data.revision !== this.valueResponse?.revision) {
          this.valueItems = [];
          this.loadValues();
          return;
        }
        this.valueBusy = false;
        this.valueResponse = data;
        if (!search && !append)
          this.profiles.set(`${this.dataset.name}:${column.name}`, data);
        this.valueItems = data.success ? append ? [...this.valueItems, ...data.values ?? []] : data.values ?? [] : [];
        this.renderSuggestions();
      };
      genericRequest(
        "QuarryExploreColumn",
        { dataset: this.dataset.name, column: column.name, search, offset },
        receive,
        0,
        () => receive({
          success: false,
          error: "Could not check this column. Try again."
        })
      );
    }
    renderSuggestions() {
      this.updateValueInputs();
      const area = this.host.querySelector(
        ".quarry-explore-suggestions"
      );
      if (!area) return;
      const pane = this.element(".quarry-explore-field");
      const scroll = pane.scrollTop;
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.value : void 0;
      const data = this.valueResponse;
      if (!data) {
        area.textContent = this.valueBusy ? "Loading suggestions…" : "";
        return;
      }
      if (!data.success) {
        area.innerHTML = `<span class="quarry-explore-error">${escapeHtml(data.error ?? "Could not load suggestions.")}</span><button type="button" class="basic-button" data-action="retry-values">Retry</button>`;
        return;
      }
      if (!data.eligible || this.smallValues(this.filters[this.selected]).length) {
        pane.hidden = true;
        area.replaceChildren();
        return;
      }
      const chosen = this.readValues();
      area.innerHTML = this.valueItems.map(
        (value) => `<button type="button" class="quarry-explore-value-option" data-value="${escapeHtml(value.trim())}" aria-pressed="${chosen.includes(value.trim())}" ${canSuggestValue(value) ? "" : 'disabled title="Contains query separators; type a shorter term instead."'}><span aria-hidden="true">${chosen.includes(value.trim()) ? "✓" : ""}</span>${escapeHtml(value)}</button>`
      ).join("") + (this.valueSearch.trim() && canSuggestValue(this.valueSearch) && !this.valueItems.some(
        (value) => value.toLowerCase() === this.valueSearch.trim().toLowerCase()
      ) ? `<button type="button" class="quarry-explore-custom-term" data-action="add-term">Use “${escapeHtml(this.valueSearch.trim())}” as a search term</button>` : "") + `<div class="quarry-explore-value-status" role="status">${this.valueBusy ? "Loading suggestions…" : this.valueItems.length ? `${this.valueItems.length.toLocaleString()} of ${(data.matchingValues ?? this.valueItems.length).toLocaleString()} values` : "No matching values. Type a term and press Enter."}</div>`;
      if (focused !== void 0)
        Array.from(area.querySelectorAll("[data-value]")).find((button) => button.dataset.value === focused)?.focus({ preventScroll: true });
      pane.scrollTop = scroll;
      this.positionValues();
    }
    readValues() {
      return this.values(this.filters[this.selected]?.value ?? "");
    }
    values(value) {
      return value.split(",").map((part) => part.trim()).filter(Boolean);
    }
    draft() {
      if (this.queryTextMode) {
        const text = this.queryTextDraft?.trim() ?? "";
        if (!text)
          return {
            query: "",
            error: "Enter a query tag or its inner text."
          };
        if (text.startsWith("<") && !/^<q(?:\[\d+(?:-\d+)?\])?:[^<>]+>$/i.test(text))
          return {
            query: "",
            error: "Enter a complete <q:…> query tag."
          };
        return {
          query: text,
          error: ""
        };
      }
      const filters = [];
      for (const [index, row] of this.filters.entries()) {
        const values = this.values(row.value);
        if (!values.length) continue;
        if (!this.fields.some((field) => field.name === row.column))
          return {
            query: "",
            error: "Choose a field shared by the selected datasets."
          };
        if (values.some((value) => !canSuggestValue(value)) || /[=,;[\]<>|:]/.test(row.column))
          return {
            query: "",
            error: `Filter ${index + 1} contains query separators. Enter shorter search terms.`
          };
        const column = this.fields.find(
          (field) => field.name === row.column
        );
        if (isComparison(row.operator) && (values.length !== 1 || !Number.isFinite(Number(values[0])) || !isNumber(column) && (!Number.isInteger(Number(values[0])) || Number(values[0]) < 0)))
          return {
            query: "",
            error: `Filter ${index + 1} needs ${isNumber(column) ? "a valid number" : "a whole character count of zero or more"}.`
          };
        filters.push({
          column: row.column,
          operator: row.operator,
          values
        });
      }
      if (this.datasets.some(
        (dataset) => /[,;[\]<>|:*?]/.test(dataset.name)
      ) || this.outputs.some((column) => /[,;[\]<>|:]/.test(column)))
        return {
          query: "",
          error: "This dataset or column name contains query separators. Use Edit beside Tag preview to write the query manually."
        };
      return {
        query: buildExploreQuery(
          this.datasets.map((dataset) => dataset.name).join(","),
          filters,
          this.outputs,
          this.format
        ),
        error: ""
      };
    }
    promptTag() {
      const draft = this.draft();
      if (draft.error || !this.queryTextMode || draft.query.startsWith("<"))
        return draft;
      const pipe = querySections(draft.query).pipe;
      const inner = pipe < 0 ? draft.query : draft.query.slice(0, pipe) + draft.query.slice(pipe).replace(
        /"(?:\\.|[^"\\])*"/g,
        (quoted) => quoted.replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
      );
      if (/[<>]/.test(inner))
        return {
          query: "",
          error: "This query can be tested, but unquoted angle brackets cannot be inserted in a prompt tag."
        };
      return { query: `<q:${inner}>`, error: "" };
    }
    renderDraft() {
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
      this.element(".quarry-explore-query").innerHTML = this.queryTextMode ? escapeHtml(tag.query || query) : query ? "&lt;q:" + names.map(
        (name) => `<button type="button" class="quarry-explore-query-dataset" data-action="choose-datasets" title="Switch dataset or add another dataset">${escapeHtml(name)}</button>`
      ).join(",") + this.renderQuerySuffix(query.slice(3 + names.join(",").length)) : "";
      this.element(".quarry-explore-result-status").textContent = this.resultsQuery && (this.resultsQuery !== query || this.resultsLimit !== this.sampleLimit) ? "Results from the last test. Test query to update." : this.pendingQuery ? "Drawing random matches…" : this.resultsQuery ? "" : "Test query to preview these settings.";
      this.element('[data-action="copy"]').textContent = "Copy tag";
      for (const action of ["test", "use", "copy"])
        this.element(
          `[data-action="${action}"]`
        ).disabled = !!error || action !== "test" && !!tag.error || action === "test" && this.pendingQuery === query;
    }
    testQuery() {
      const { query, error } = this.draft();
      if (error || this.pendingQuery === query) return;
      const request2 = ++this.request;
      const limit = this.sampleLimit;
      this.pendingQuery = query;
      const button = this.element('[data-action="test"]');
      button.disabled = true;
      this.element(".quarry-explore-result-status").textContent = "Drawing random matches…";
      genericRequest(
        "QuarryRunQuery",
        { query, maxResults: this.sampleLimit },
        (data) => {
          if (this.disposed || request2 !== this.request) return;
          button.disabled = false;
          this.pendingQuery = null;
          this.resultsQuery = query;
          this.resultsLimit = limit;
          this.element(".quarry-explore-result-status").textContent = "";
          if (this.queryTextMode) {
            const result = renderRunQueryResponse(data);
            this.element(".quarry-explore-results").innerHTML = `<code class="quarry-query-tested">${escapeHtml(query)}</code>${result.summary}<div class="quarry-explore-result-scroll" tabindex="0" role="region" aria-label="Query results">${result.body}</div>`;
          } else this.renderResults(data);
        },
        0,
        () => {
          if (this.disposed || request2 !== this.request) return;
          button.disabled = false;
          this.pendingQuery = null;
          this.element(".quarry-explore-result-status").textContent = "Query failed. Try again.";
        }
      );
    }
    async copy(text, button) {
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
            "notice-pop-green quarry-copy-notice"
          );
      } else {
        this.element(".quarry-explore-result-status").textContent = "Copy failed. Select the text and copy it manually.";
      }
    }
    click = (event) => {
      const target = event.target;
      this.outsideValues(event);
      if (target.matches(".quarry-explore-value")) this.openValues();
      const button = target.closest("button");
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
      } else if (button.dataset.namespace !== void 0) {
        const open = button.getAttribute("aria-expanded") === "true";
        button.setAttribute("aria-expanded", String(!open));
        const items = button.parentElement?.querySelector(
          ".quarry-explore-namespace-items"
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
      } else if (button.dataset.browseDataset || ["previous-dataset", "next-dataset"].includes(
        button.dataset.action ?? ""
      )) {
        if (this.combine && this.view !== "overview" || !button.dataset.browseDataset && this.datasets.length !== 1)
          return;
        const datasets2 = this.railDatasets();
        const index = datasets2.findIndex(
          (item) => item.name === this.dataset.name
        );
        const dataset = button.dataset.browseDataset ? this.availableDatasets.find(
          (item) => item.name === button.dataset.browseDataset
        ) : datasets2[index + (button.dataset.action === "next-dataset" ? 1 : -1)];
        if (!dataset || dataset.error || !dataset.columns.length || dataset.name === this.dataset.name && this.datasets.length === 1 && this.view !== "overview")
          return;
        this.updateDatasets([dataset], true, true);
        if (!button.isConnected || button.disabled) {
          this.host.querySelector(
            '[data-browse-dataset][aria-current="true"]'
          )?.focus();
        }
      } else if (button.dataset.valuesRow !== void 0) {
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
        const datasets2 = this.datasets.filter(
          (dataset) => dataset.name !== button.dataset.removeDataset
        );
        if (datasets2.length && datasets2.length !== this.datasets.length)
          this.updateDatasets(datasets2, false);
      } else if (button.dataset.view) {
        this.setView(button.dataset.view);
        if (button.dataset.view === "rows") this.newSample();
      } else if (button.dataset.value !== void 0 || button.dataset.removeTerm !== void 0) {
        const row = button.closest("[data-row]");
        if (row && Number(row.dataset.row) !== this.selected)
          this.selectRow(Number(row.dataset.row));
        const values = this.readValues();
        const value = button.dataset.value ?? button.dataset.removeTerm ?? "";
        this.filters[this.selected].value = (values.includes(value) ? values.filter((item) => item !== value) : [...values, value]).join(", ");
        this.filters[this.selected].term = "";
        if (this.valueSearch) {
          this.valueSearch = "";
          if (this.searchTimer) clearTimeout(this.searchTimer);
          this.loadValues();
        } else this.renderSuggestions();
        this.renderDraft();
        if (button.dataset.removeTerm !== void 0)
          this.element(
            `[data-row="${this.selected}"] .quarry-explore-value`
          ).focus();
      } else if (button.dataset.action === "add-term") {
        this.commitTerm();
        this.valueSearch = "";
        this.loadValues();
      } else if (button.dataset.remove !== void 0) {
        if (this.filters.length === 1) return;
        const index = Number(button.dataset.remove);
        this.filters.splice(index, 1);
        if (!this.filters.length) this.filters.push(this.blankFilter());
        this.selected = Math.min(index, this.filters.length - 1);
        this.renderFilters();
        this.selectRow(this.selected);
        this.renderDraft();
      } else if (button.dataset.removeOutput !== void 0) {
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
        this.element(
          `[data-row="${this.selected}"] .quarry-explore-value`
        ).focus();
        this.renderDraft();
      } else if (button.dataset.action === "clear-filters") {
        this.filters = [this.blankFilter()];
        this.selected = 0;
        this.closeAuxiliaryPanels();
        this.renderFilters();
        this.selectRow(0);
        this.renderDraft();
        this.element(".quarry-explore-value").focus();
      } else if (button.dataset.action === "test") this.testQuery();
      else if (button.dataset.action === "copy" || button.dataset.action === "use") {
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
          button.closest("tr")?.querySelector(".quarry-runquery-prompt-text")?.textContent ?? "",
          button
        );
      }
    };
  };

  // frontend/folderPicker.ts
  var escapeAttr = escapeHtml;
  var renderFolderPills = (selected) => {
    if (selected.length === 0) {
      return `<span class="quarry-search-folder-placeholder">No folders selected</span>`;
    }
    return selected.map(
      (value) => `<span class="quarry-search-folder-pill">${escapeHtml(value || "All")}<button type="button" class="quarry-search-folder-pill-x" data-quarry-search-folder-pill-remove data-value="${escapeAttr(value)}" title="Remove ${escapeAttr(value || "All")}">✕</button></span>`
    ).join("");
  };
  var renderFolderPicker = (selected, options) => {
    const withValues = ["", ...options.filter(Boolean)];
    const availableSelected = selected.filter(
      (value) => withValues.includes(value)
    );
    const checked = (value) => availableSelected.some(
      (parent) => parent === "" || parent === value || value.startsWith(`${parent}/`)
    );
    const checkboxes = withValues.map(
      (opt) => `<label class="quarry-search-folder-option"><input type="checkbox" data-quarry-search-folder-check value="${escapeAttr(opt)}"${checked(opt) ? " checked" : ""}><span>${escapeHtml(opt || "All")}</span></label>`
    ).join("");
    return `
            <div class="quarry-search-folder-picker" data-quarry-search-folder-picker>
                <div class="quarry-search-folder-trigger" data-quarry-search-folder-trigger role="button" tabindex="0" aria-label="Image search folders" aria-expanded="false" title="Image search folders - click to edit">
                    <span class="quarry-search-folder-pills" data-quarry-search-folder-pills>${renderFolderPills(availableSelected)}</span>
                    <span class="quarry-search-folder-caret">▾</span>
                </div>
                <div class="quarry-search-folder-panel" data-quarry-search-folder-panel hidden>
                    <input type="text" class="auto-text quarry-search-folder-filter" data-quarry-search-folder-filter aria-label="Filter image search folders" placeholder="Filter folders..." autocomplete="off">
                    <div class="quarry-search-folder-list">${checkboxes}</div>
                    <div class="quarry-search-folder-actions">
                        <span class="quarry-search-folder-count" data-quarry-search-folder-count></span>
                        <button type="button" class="basic-button quarry-search-folder-clear" data-quarry-search-folder-clear>Clear</button>
                    </div>
                </div>
            </div>`;
  };
  var checkedValues = (picker) => Array.from(
    picker.querySelectorAll(
      "[data-quarry-search-folder-check]"
    )
  ).filter((box) => box.checked).map((box) => box.value);
  var selectedFolderValues = (picker) => {
    const values = checkedValues(picker);
    return values.includes("") ? [""] : values.filter(
      (value) => !values.some((parent) => value.startsWith(`${parent}/`))
    );
  };
  var changeSelection = (picker, value, checked) => {
    for (const box of picker.querySelectorAll(
      "[data-quarry-search-folder-check]"
    )) {
      if (value === "" || box.value === value || box.value.startsWith(`${value}/`)) {
        box.checked = checked;
      } else if (!checked && (box.value === "" || value.startsWith(`${box.value}/`))) {
        box.checked = false;
      }
    }
    syncPicker(picker);
  };
  var syncPicker = (picker) => {
    const selected = selectedFolderValues(picker);
    const pills = picker.querySelector("[data-quarry-search-folder-pills]");
    if (pills) {
      pills.innerHTML = renderFolderPills(selected);
    }
    const count = picker.querySelector("[data-quarry-search-folder-count]");
    if (count) {
      count.textContent = selected.includes("") ? "All folders selected" : `${selected.length} selected`;
    }
  };
  var shouldOpenUpward = (spaceAbove, spaceBelow, panelHeight, margin = 12) => spaceBelow < panelHeight + margin && spaceAbove > spaceBelow;
  var setPanelOpen = (picker, open) => {
    const panel = picker.querySelector(
      "[data-quarry-search-folder-panel]"
    );
    if (!panel) {
      return;
    }
    panel.hidden = !open;
    picker.querySelector("[data-quarry-search-folder-trigger]")?.setAttribute("aria-expanded", String(open));
    if (open) {
      syncPicker(picker);
      panel.classList.remove("quarry-search-folder-panel-up");
      const trigger = picker.querySelector(
        "[data-quarry-search-folder-trigger]"
      );
      if (trigger) {
        const rect = trigger.getBoundingClientRect();
        if (shouldOpenUpward(
          rect.top,
          window.innerHeight - rect.bottom,
          panel.offsetHeight
        )) {
          panel.classList.add("quarry-search-folder-panel-up");
        }
      }
      picker.querySelector(
        "[data-quarry-search-folder-filter]"
      )?.focus();
    }
  };
  var closeAllPanels = (root, except) => {
    for (const picker of Array.from(
      root.querySelectorAll("[data-quarry-search-folder-picker]")
    )) {
      if (picker !== except) {
        setPanelOpen(picker, false);
      }
    }
  };
  var applyFilter = (picker, filterText) => {
    const wanted = filterText.trim().toLowerCase();
    for (const label of Array.from(
      picker.querySelectorAll(".quarry-search-folder-option")
    )) {
      const value = label.querySelector(
        "[data-quarry-search-folder-check]"
      )?.value ?? "";
      label.style.display = !wanted || value === "" || value.toLowerCase().includes(wanted) ? "" : "none";
    }
  };
  var started = false;
  var initFolderPickers = (root) => {
    if (started) {
      return;
    }
    started = true;
    root.addEventListener("click", (e) => {
      const target = e.target;
      if (!target) {
        return;
      }
      const pillRemove = target.closest(
        "[data-quarry-search-folder-pill-remove]"
      );
      if (pillRemove) {
        const picker = pillRemove.closest(
          "[data-quarry-search-folder-picker]"
        );
        if (picker) {
          changeSelection(picker, pillRemove.dataset.value ?? "", false);
        }
        e.stopPropagation();
        return;
      }
      const trigger = target.closest("[data-quarry-search-folder-trigger]");
      if (trigger) {
        const picker = trigger.closest(
          "[data-quarry-search-folder-picker]"
        );
        if (picker) {
          const panel = picker.querySelector(
            "[data-quarry-search-folder-panel]"
          );
          closeAllPanels(root, picker);
          setPanelOpen(picker, panel ? Boolean(panel.hidden) : true);
        }
        return;
      }
      const clear = target.closest("[data-quarry-search-folder-clear]");
      if (clear) {
        const picker = clear.closest("[data-quarry-search-folder-picker]");
        if (picker) {
          changeSelection(picker, "", false);
        }
        return;
      }
      if (!target.closest("[data-quarry-search-folder-picker]")) {
        closeAllPanels(root);
      }
    });
    root.addEventListener("change", (e) => {
      const target = e.target;
      if (!target?.matches?.("[data-quarry-search-folder-check]")) {
        return;
      }
      const picker = target.closest("[data-quarry-search-folder-picker]");
      if (picker) {
        changeSelection(picker, target.value, target.checked);
      }
    });
    root.addEventListener("input", (e) => {
      const target = e.target;
      if (!target?.matches?.("[data-quarry-search-folder-filter]")) {
        return;
      }
      const picker = target.closest("[data-quarry-search-folder-picker]");
      if (picker) {
        applyFilter(picker, target.value);
      }
    });
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const openPicker = root.querySelector(
          "[data-quarry-search-folder-panel]:not([hidden])"
        )?.closest("[data-quarry-search-folder-picker]");
        openPicker?.querySelector(
          "[data-quarry-search-folder-trigger]"
        )?.focus();
        closeAllPanels(root);
        return;
      }
      const target = e.target;
      if (e.key === "Enter" && target?.matches("[data-quarry-search-folder-filter]")) {
        e.preventDefault();
      }
      if ((e.key === "Enter" || e.key === " ") && target?.matches?.("[data-quarry-search-folder-trigger]")) {
        e.preventDefault();
        target.click();
      }
    });
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
    const body2 = pane.firstElementChild;
    const fitViewport = () => {
      if (!pane.getClientRects().length) return;
      body2.style.maxHeight = `${Math.max(0, window.innerHeight - pane.getBoundingClientRect().top)}px`;
    };
    if (typeof ResizeObserver !== "undefined")
      new ResizeObserver(fitViewport).observe(pane);
    window.addEventListener("resize", fitViewport);
    fitViewport();
    const navLink = li.querySelector("a");
    if (navLink) {
      registerTabWithLayout2(navLink);
    }
  };

  // frontend/settings.ts
  var MESSAGE_TIMEOUT_MS = 5e3;
  var PREVIEW_ROW_LIMIT = 100;
  var PREVIEW_MODAL_ID = "quarry-preview-modal";
  var PREVIEW_BODY_ID = "quarry-preview-body";
  var PREVIEW_STATUS_ID = "quarry-preview-status";
  var PREVIEW_REFRESH_ID = "quarry-preview-refresh";
  var renderTagCheckboxes = (dataset) => dataset.columns.map((col) => {
    const checked = (dataset.configuredTagColumns ?? []).includes(
      col.name
    ) ? " checked" : "";
    const badge = col.kind === "scalar" ? "" : ` [${col.kind}]`;
    return `<label class="quarry-tag-option"><input type="checkbox" class="quarry-dataset-tag" data-dataset="${escapeHtml(dataset.name)}" value="${escapeHtml(col.name)}"${checked}> ${escapeHtml(col.name)}${badge}</label>`;
  }).join("");
  var ENABLE_TITLE = "Enabled — included when a <q:> wildcard (like **) matches it. Click to disable.";
  var DISABLE_TITLE = "Disabled — skipped by <q:> wildcards, but still used when a prompt names it explicitly. Click to enable.";
  var isDatasetEnabled = (dataset) => dataset.enabled !== false;
  var renderEnableToggle = (name, enabled) => {
    const stateCls = enabled ? "quarry-enabled" : "quarry-disabled";
    const title = enabled ? ENABLE_TITLE : DISABLE_TITLE;
    return `<button type="button" class="quarry-dataset-enable ${stateCls}" role="switch" aria-label="Include ${escapeHtml(name)} in wildcards" aria-checked="${enabled}" data-dataset="${escapeHtml(name)}" title="${escapeHtml(title)}"><span class="quarry-enable-knob" aria-hidden="true"></span></button>`;
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
            <div class="quarry-workspace">
                <div class="quarry-workspace-content">
                    <div class="quarry-actions quarry-catalog-toolbar">
                        <button type="button" class="basic-button" data-library-view="library" aria-pressed="true">Library</button>
                        <button type="button" id="quarry-refresh" class="basic-button">Refresh Datasets</button>
                        <button type="button" id="quarry-download-datasets" class="basic-button" data-library-view="downloads" aria-pressed="false" aria-controls="quarry-download-panel" title="Browse and download ready-made datasets from the official collection">Download Datasets</button>
                        <button type="button" id="quarry-settings-toggle" class="basic-button" aria-expanded="false" aria-controls="quarry-global-settings">Quarry settings</button>
                    </div>
                    <section id="quarry-global-settings" class="quarry-global-settings" aria-label="Quarry settings" hidden><form id="quarry-form">
                        <h3>Quarry settings</h3>
                        <label class="quarry-folder-setting" for="quarry-folder">Datasets folder
                            <input class="auto-text" type="text" id="quarry-folder" value="${escapeHtml(folder)}" placeholder="/path/to/datasets" autocomplete="off">
                        </label>
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
                    </form></section>
                    <div id="quarry-message" class="quarry-message" role="status"></div>
                    <div id="quarry-library-home"><div id="quarry-library" class="quarry-library"></div></div>
                    <section id="quarry-download-panel" class="quarry-download-panel" aria-label="Download datasets" hidden></section>
                </div>
            </div>
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
  var currentDatasets = [];
  var savedSettings = { success: true };
  var datasetColumnSettings = (datasets2) => ({
    promptColumns: Object.fromEntries(
      datasets2.filter((dataset) => dataset.configuredPromptColumn != null).map((dataset) => [dataset.name, dataset.configuredPromptColumn])
    ),
    tagColumns: Object.fromEntries(
      datasets2.map((dataset) => [
        dataset.name,
        [...dataset.configuredTagColumns]
      ])
    )
  });
  var savedSettingsRequest = () => {
    const { promptColumns, tagColumns } = datasetColumnSettings(currentDatasets);
    return {
      datasetsFolder: savedSettings.datasetsFolder ?? "",
      promptColumnsJson: JSON.stringify(promptColumns),
      tagColumnsJson: JSON.stringify(tagColumns),
      disabledDatasetsJson: JSON.stringify(
        currentDatasets.filter((dataset) => dataset.enabled === false).map((dataset) => dataset.name)
      ),
      addToExistingTag: savedSettings.addToExistingTag ?? true,
      exploreUniqueLimit: savedSettings.exploreUniqueLimit ?? 1e4,
      exploreLengthLimit: savedSettings.exploreLengthLimit ?? 256,
      exploreDistinctPercent: savedSettings.exploreDistinctPercent ?? 10
    };
  };
  var rememberSavedDatasetState = (data) => {
    savedSettings = data;
    currentDatasets = data.datasets?.map((updated) => {
      const existing = currentDatasets.find(
        (item) => item.name === updated.name
      );
      return existing ? Object.assign(existing, updated) : updated;
    }) ?? currentDatasets;
    setCompletionDatasets(currentDatasets);
  };
  var settingsRequests = [];
  var requestSettings = (endpoint, request2, receive, fail) => {
    const finish = (callback) => {
      try {
        callback();
      } finally {
        settingsRequests.shift();
        settingsRequests[0]?.();
      }
    };
    settingsRequests.push(() => {
      genericRequest(
        endpoint,
        request2(),
        (data) => finish(() => receive(data)),
        0,
        () => finish(fail)
      );
    });
    if (settingsRequests.length === 1) settingsRequests[0]();
  };
  var mountImageSearchFolders = (host, onPermission = () => {
  }) => {
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
        const picker = host.querySelector(
          "[data-image-search-folder-picker]"
        );
        const button = host.querySelector(
          "[data-save-search-folders]"
        );
        const status = host.querySelector(
          "[data-search-folders-status]"
        );
        if (!picker || !button || !status) return;
        syncPicker(picker);
        button.addEventListener("click", () => {
          button.disabled = true;
          status.textContent = "Saving…";
          const fail = (message) => {
            button.disabled = false;
            status.textContent = message;
          };
          const folders = selectedFolderValues(picker);
          requestSettings(
            "QuarrySaveSettings",
            () => ({
              ...savedSettingsRequest(),
              imageSearchDirectoriesJson: JSON.stringify(folders)
            }),
            (response) => {
              if (!response.success) {
                fail(
                  `Failed to save: ${response.error ?? "unknown error"}`
                );
                return;
              }
              rememberSavedDatasetState(response);
              button.disabled = false;
              status.textContent = "Folders saved. Rescan history to update the index.";
            },
            () => fail("Failed to save folders. Try again.")
          );
        });
      },
      () => {
        host.textContent = "Failed to load search folders. Try again.";
      }
    );
  };
  var renderDatasetSettings = (dataset) => `
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
  var mountDatasetSettings = (host, dataset, onSaved) => {
    host.innerHTML = renderDatasetSettings(dataset);
    let disposed = false;
    const button = host.querySelector(
      "[data-save-dataset-settings]"
    );
    const status = host.querySelector(
      "[data-dataset-settings-status]"
    );
    const outputSelect = host.querySelector(
      ".quarry-dataset-column"
    );
    if (!button || !status || !outputSelect) return () => {
    };
    const controls = host.querySelectorAll("input, select, button");
    const setSaving = (saving) => {
      controls.forEach((control) => {
        control.disabled = saving;
      });
    };
    const save = () => {
      const output = outputSelect.value;
      const tags = collectTagColumns(host)[dataset.name] ?? [];
      setSaving(true);
      status.textContent = "Saving…";
      const fail = (message) => {
        if (disposed) return;
        setSaving(false);
        status.textContent = message;
      };
      requestSettings(
        "QuarrySaveSettings",
        () => {
          const { promptColumns, tagColumns } = datasetColumnSettings(currentDatasets);
          if (output) promptColumns[dataset.name] = output;
          else delete promptColumns[dataset.name];
          tagColumns[dataset.name] = tags;
          return {
            ...savedSettingsRequest(),
            promptColumnsJson: JSON.stringify(promptColumns),
            tagColumnsJson: JSON.stringify(tagColumns)
          };
        },
        (data) => {
          if (!data.success) {
            fail(`Failed to save: ${data.error ?? "unknown error"}`);
            return;
          }
          rememberSavedDatasetState(data);
          if (disposed) return;
          setSaving(false);
          status.textContent = "Dataset settings saved.";
          const updated = currentDatasets.find(
            (item) => item.name === dataset.name
          );
          if (updated) onSaved(updated);
        },
        () => fail("Failed to save dataset settings. Try again.")
      );
    };
    button.addEventListener("click", save);
    return () => {
      disposed = true;
      button.removeEventListener("click", save);
    };
  };
  var applyResponse = (data) => {
    rememberSavedDatasetState(data);
    for (const [id, value] of [
      ["quarry-explore-unique-limit", data.exploreUniqueLimit ?? 1e4],
      ["quarry-explore-length-limit", data.exploreLengthLimit ?? 256],
      ["quarry-explore-distinct-percent", data.exploreDistinctPercent ?? 10]
    ]) {
      const input = document.getElementById(id);
      if (input) input.value = String(value);
    }
    const folderEl = document.getElementById(
      "quarry-folder"
    );
    if (folderEl) folderEl.value = data.datasetsFolder ?? "";
    mountLibrary();
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
          showMessage2("Failed to load settings. Try again.", "error");
        } else {
          const host = document.getElementById(QUARRY_TAB_BODY_ID);
          if (host)
            host.textContent = "Failed to load settings. Reload the page to try again.";
        }
      }
    );
  };
  var saveSettings = () => {
    const folder = document.getElementById("quarry-folder").value.trim();
    const changes = {
      datasetsFolder: folder,
      addToExistingTag: savedSettings.addToExistingTag ?? true,
      exploreUniqueLimit: Number(
        document.getElementById(
          "quarry-explore-unique-limit"
        ).value
      ),
      exploreLengthLimit: Number(
        document.getElementById(
          "quarry-explore-length-limit"
        ).value
      ),
      exploreDistinctPercent: Number(
        document.getElementById(
          "quarry-explore-distinct-percent"
        ).value
      )
    };
    requestSettings(
      "QuarrySaveSettings",
      () => ({ ...savedSettingsRequest(), ...changes }),
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
      },
      () => showMessage2("Failed to save settings. Try again.", "error")
    );
  };
  var refresh = () => {
    const button = document.getElementById(
      "quarry-refresh"
    );
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
          showMessage2(data.message ?? "Refreshed.", "success");
        } else {
          showMessage2(
            `Refresh failed: ${data.error ?? "unknown error"}`,
            "error"
          );
        }
      },
      () => {
        if (button) button.disabled = false;
        showMessage2("Failed to refresh datasets. Try again.", "error");
      }
    );
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
  var previewBusy = false;
  var previewRequest = 0;
  var previewError = "";
  var explorer = null;
  var ensurePreviewModal = () => {
    if (document.getElementById(PREVIEW_MODAL_ID)) {
      return;
    }
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.id = PREVIEW_MODAL_ID;
    modal.tabIndex = -1;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-label", "Explore datasets");
    modal.innerHTML = `
        <div class="modal-dialog modal-xl quarry-preview-dialog" role="document">
            <div class="modal-content">
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
    modal.addEventListener("hidden.bs.modal", restoreLibrary);
    modal.querySelector('[data-bs-dismiss="modal"]')?.addEventListener("click", hidePreviewModal);
    document.getElementById(PREVIEW_REFRESH_ID)?.addEventListener("click", newPreviewSample);
  };
  var showPreviewModal = () => {
    if (typeof $ === "function") {
      $(`#${PREVIEW_MODAL_ID}`).modal("show");
    }
  };
  var restoreLibrary = () => {
    const home = document.getElementById("quarry-library-home");
    const host = document.getElementById("quarry-library");
    if (!home || !host) return;
    home.append(host);
    explorer?.showOverview();
    syncLibraryToolbar();
  };
  var hidePreviewModal = () => {
    if (typeof $ === "function") {
      $(`#${PREVIEW_MODAL_ID}`).modal("hide");
    } else restoreLibrary();
  };
  var applyRowCount = (dataset, count) => {
    const entry = currentDatasets.find((d) => d.name === dataset);
    if (entry) {
      entry.rowCount = count;
      explorer?.refreshMetadata();
    }
  };
  var updatePreviewControls = () => {
    const refresh2 = document.getElementById(
      PREVIEW_REFRESH_ID
    );
    const status = document.getElementById(PREVIEW_STATUS_ID);
    if (refresh2) refresh2.disabled = previewBusy || !previewDataset;
    if (status) {
      status.textContent = previewBusy ? "Loading…" : previewError || renderPreviewStatus(previewShown, previewTotal);
    }
  };
  var fetchPreview = (dataset) => {
    const request2 = ++previewRequest;
    previewBusy = true;
    previewError = "";
    updatePreviewControls();
    genericRequest(
      "QuarryPreviewDataset",
      { dataset, limit: PREVIEW_ROW_LIMIT },
      (data) => {
        if (request2 !== previewRequest) {
          return;
        }
        previewBusy = false;
        if (!data.success) {
          previewError = data.error ?? "Failed to load rows. Try loading again.";
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
        if (request2 !== previewRequest) return;
        previewBusy = false;
        previewError = "Failed to load rows. Try again.";
        updatePreviewControls();
      }
    );
  };
  var syncLibraryToolbar = (useLibrary = true) => {
    const toolbar = document.querySelector(
      ".quarry-catalog-toolbar"
    );
    const workspace = document.querySelector(
      ".quarry-workspace-content"
    );
    if (!toolbar || !workspace) return;
    const overview = explorer?.elementHost.querySelector(
      ".quarry-library-overview"
    );
    const actions = explorer?.elementHost.querySelector(
      ".quarry-library-actions"
    );
    const inLibrary = useLibrary && overview && !overview.hidden && overview.closest("#quarry-library-home:not([hidden])");
    if (inLibrary) {
      if (toolbar.parentElement !== overview) overview.prepend(toolbar);
      if (actions && actions.parentElement !== toolbar)
        toolbar.append(actions);
    } else {
      if (toolbar.parentElement !== workspace) workspace.prepend(toolbar);
      if (overview && actions && actions.parentElement !== overview)
        overview.prepend(actions);
    }
  };
  var libraryView = "library";
  var setLibraryView = (view) => {
    const focused = document.activeElement;
    if (view !== "settings") libraryView = view;
    const settings = document.getElementById("quarry-global-settings");
    if (settings) settings.hidden = view !== "settings";
    document.getElementById("quarry-settings-toggle")?.setAttribute("aria-expanded", String(view === "settings"));
    const home = document.getElementById("quarry-library-home");
    const downloads = document.getElementById("quarry-download-panel");
    if (home) home.hidden = view !== "library";
    if (downloads) {
      downloads.hidden = view !== "downloads";
      if (view === "downloads") mountDownloads(downloads, loadSettings);
    }
    const refreshButton = document.getElementById("quarry-refresh");
    if (refreshButton) refreshButton.hidden = view === "downloads";
    syncLibraryToolbar();
    if (focused instanceof HTMLElement && focused.matches("[data-library-view], #quarry-settings-toggle"))
      focused.focus();
    document.querySelectorAll("[data-library-view]").forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.libraryView === view)
      );
    });
  };
  var expandLibrary = () => {
    if (!explorer) return;
    ensurePreviewModal();
    const body2 = document.getElementById(PREVIEW_BODY_ID);
    if (!body2) return;
    body2.append(explorer.elementHost);
    explorer.expand();
    syncLibraryToolbar();
    showPreviewModal();
  };
  var mountLibrary = () => {
    const host = document.getElementById("quarry-library");
    if (!host) return;
    const inModal = host.parentElement?.id === PREVIEW_BODY_ID;
    const existing = explorer?.elementHost === host;
    const selected = currentDatasets.find(
      (item) => existing && item.name === explorer?.sourceName && !item.error && item.columns.length
    );
    if (existing && selected) {
      explorer?.updateCatalog(currentDatasets);
      return;
    }
    syncLibraryToolbar(false);
    explorer?.dispose();
    explorer = null;
    previewRequest++;
    previewBusy = false;
    previewError = "";
    const entry = selected ?? currentDatasets.find(
      (item) => item.name.startsWith("nl/") && !item.error && item.columns.length
    ) ?? currentDatasets.find((item) => !item.error && item.columns.length);
    if (!entry) {
      host.innerHTML = `<div class="quarry-library-empty"><p class="quarry-preview-empty">${currentDatasets.length ? "No datasets can be previewed." : "No datasets installed. Download datasets to get started."}</p>${currentDatasets.length ? `<ul>${currentDatasets.map((dataset) => `<li><strong>${escapeHtml(dataset.name)}</strong>: ${escapeHtml(dataset.error || "Dataset has no available columns.")}</li>`).join("")}</ul>` : ""}</div>`;
      previewDataset = null;
      for (const id of [PREVIEW_REFRESH_ID, PREVIEW_STATUS_ID]) {
        const control = document.getElementById(id);
        if (control) control.hidden = true;
      }
      return;
    }
    previewDataset = entry.name;
    previewShown = 0;
    previewTotal = null;
    explorer = new DatasetExplorer(
      host,
      entry,
      renderPreviewTable,
      hidePreviewModal,
      newPreviewSample,
      (showRows) => {
        const refresh2 = document.getElementById(PREVIEW_REFRESH_ID);
        if (refresh2) refresh2.hidden = !showRows;
        const status = document.getElementById(PREVIEW_STATUS_ID);
        if (status) status.hidden = !showRows;
      },
      currentDatasets,
      (source) => {
        if (previewDataset === source.name) return;
        previewDataset = source.name;
        previewShown = 0;
        previewTotal = null;
        previewError = "";
        previewRequest++;
        previewBusy = false;
        if (!host.querySelector(".quarry-explore-rows-view")?.hidden)
          fetchPreview(source.name);
      },
      mountDatasetSettings,
      {
        overview: !inModal,
        onExpand: () => expandLibrary(),
        renderWildcardToggle: (dataset) => renderEnableToggle(dataset.name, isDatasetEnabled(dataset))
      }
    );
    if (inModal) explorer.expand();
    syncLibraryToolbar();
    host.onclick = (event) => {
      const toggle = event.target.closest(
        ".quarry-dataset-enable"
      );
      if (toggle) toggleDatasetEnabled(toggle);
    };
  };
  var newPreviewSample = () => {
    if (previewDataset) {
      fetchPreview(previewDataset);
    }
  };
  var applyEnabledState = (button, enabled) => {
    button.setAttribute("aria-checked", String(enabled));
    button.classList.toggle("quarry-enabled", enabled);
    button.classList.toggle("quarry-disabled", !enabled);
    button.setAttribute("title", enabled ? ENABLE_TITLE : DISABLE_TITLE);
  };
  var toggleDatasetEnabled = (button) => {
    const name = button.getAttribute("data-dataset");
    if (!name) return;
    const next = button.getAttribute("aria-checked") === "false";
    const updateButton = (enabled, pending) => {
      const live = Array.from(
        document.querySelectorAll(
          ".quarry-dataset-enable"
        )
      ).filter((item) => item.getAttribute("data-dataset") === name);
      for (const button2 of live) {
        applyEnabledState(button2, enabled);
        button2.disabled = pending;
      }
    };
    const fail = (message) => {
      const dataset = currentDatasets.find((item) => item.name === name);
      updateButton(dataset?.enabled !== false, false);
      showMessage2(message, "error");
    };
    updateButton(next, true);
    requestSettings(
      "QuarrySetDatasetEnabled",
      () => {
        updateButton(next, true);
        return { dataset: name, enabled: next };
      },
      (data) => {
        if (data.success) {
          const dataset = currentDatasets.find(
            (item) => item.name === name
          );
          if (dataset) dataset.enabled = next;
          explorer?.refreshMetadata();
          updateButton(next, false);
        } else {
          fail(
            `Failed to ${next ? "enable" : "disable"} '${name}': ${data.error ?? "unknown error"}`
          );
        }
      },
      () => fail(
        `Failed to ${next ? "enable" : "disable"} '${name}'. Try again.`
      )
    );
  };
  var ensureFormRendered = () => {
    initFolderPickers(document);
    if (document.getElementById("quarry-form")) {
      return;
    }
    const host = document.getElementById(QUARRY_TAB_BODY_ID);
    if (!host) {
      return;
    }
    libraryView = "library";
    host.innerHTML = renderForm("");
    document.getElementById("quarry-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      saveSettings();
    });
    document.querySelectorAll("[data-library-view]").forEach((button) => {
      button.addEventListener(
        "click",
        () => setLibraryView(button.dataset.libraryView ?? "library")
      );
    });
    document.getElementById("quarry-refresh")?.addEventListener("click", refresh);
    document.getElementById("quarry-settings-toggle")?.addEventListener("click", () => {
      const panel = document.getElementById("quarry-global-settings");
      if (panel) setLibraryView(panel.hidden ? "settings" : libraryView);
    });
    document.getElementById("quarry-clean-temp")?.addEventListener("click", cleanTempFiles);
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
  };
  var quarry = {
    init
  };

  // frontend/search.ts
  var POLL_MS2 = 800;
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
                    <button type="button" class="basic-button" id="imagesearch-folders-toggle" aria-expanded="false" aria-controls="imagesearch-folders-settings" hidden>Search folders</button>
                    <button type="button" class="basic-button" id="imagesearch-rescan">Rescan history</button>
                    <button type="button" class="basic-button" id="imagesearch-cancel-scan" style="display:none">Cancel</button>
                </span>
            </div>
            <div id="imagesearch-folders-settings" class="imagesearch-folders-settings" hidden></div>
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
          scanPollTimer = setTimeout(pollScanOnce, POLL_MS2);
          return;
        }
        renderScanStatus(status);
        if (status.active) {
          scanPollTimer = setTimeout(pollScanOnce, POLL_MS2);
          return;
        }
        finishScan(status);
      },
      () => {
        scanPollTimer = setTimeout(pollScanOnce, POLL_MS2);
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
    el("imagesearch-folders-toggle")?.addEventListener("click", () => {
      const panel = el("imagesearch-folders-settings");
      const button = el("imagesearch-folders-toggle");
      if (!panel || !button) return;
      panel.hidden = !panel.hidden;
      button.setAttribute("aria-expanded", String(!panel.hidden));
    });
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
    const folders = el("imagesearch-folders-settings");
    if (folders)
      mountImageSearchFolders(folders, (allowed) => {
        const button = el("imagesearch-folders-toggle");
        if (button) button.hidden = !allowed;
      });
    loadFields(() => {
      ensureOneFilterRow();
      if (available && hasIndex) {
        runSearch();
      }
      resumeScanIfActive();
    });
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
