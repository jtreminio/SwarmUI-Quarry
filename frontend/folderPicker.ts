import { escapeHtml } from "./util";

const escapeAttr = escapeHtml;

// --- Pure renderers ----------------------------------------------------------

/** Inner content of the trigger's pill area. */
export const renderFolderPills = (selected: string[]): string => {
    if (selected.length === 0) {
        return `<span class="quarry-search-folder-placeholder">No folders selected</span>`;
    }
    return selected
        .map(
            (value) =>
                `<span class="quarry-search-folder-pill">${escapeHtml(value || "All")}<button type="button" class="quarry-search-folder-pill-x" data-quarry-search-folder-pill-remove data-value="${escapeAttr(value)}" title="Remove ${escapeAttr(value || "All")}">✕</button></span>`,
        )
        .join("");
};

/** Render only folders in the current available list. */
export const renderFolderPicker = (
    selected: string[],
    options: string[],
): string => {
    const withValues = ["", ...options.filter(Boolean)];
    const availableSelected = selected.filter((value) =>
        withValues.includes(value),
    );
    const checked = (value: string): boolean =>
        availableSelected.some(
            (parent) =>
                parent === "" ||
                parent === value ||
                value.startsWith(`${parent}/`),
        );
    const checkboxes = withValues
        .map(
            (opt) =>
                `<label class="quarry-search-folder-option"><input type="checkbox" data-quarry-search-folder-check value="${escapeAttr(opt)}"${checked(opt) ? " checked" : ""}><span>${escapeHtml(opt || "All")}</span></label>`,
        )
        .join("");
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

// --- DOM sync helpers --------------------------------------------------------

const checkedValues = (picker: Element): string[] =>
    Array.from(
        picker.querySelectorAll<HTMLInputElement>(
            "[data-quarry-search-folder-check]",
        ),
    )
        .filter((box) => box.checked)
        .map((box) => box.value);

/** Selected parents include all descendants; an empty value represents All. */
export const selectedFolderValues = (picker: Element): string[] => {
    const values = checkedValues(picker);
    return values.includes("")
        ? [""]
        : values.filter(
              (value) =>
                  !values.some((parent) => value.startsWith(`${parent}/`)),
          );
};

const changeSelection = (
    picker: Element,
    value: string,
    checked: boolean,
): void => {
    for (const box of picker.querySelectorAll<HTMLInputElement>(
        "[data-quarry-search-folder-check]",
    )) {
        if (
            value === "" ||
            box.value === value ||
            box.value.startsWith(`${value}/`)
        ) {
            box.checked = checked;
        } else if (
            !checked &&
            (box.value === "" || value.startsWith(`${box.value}/`))
        ) {
            box.checked = false;
        }
    }
    syncPicker(picker);
};

/** Propagate the checkbox state to the pills and count. */
export const syncPicker = (picker: Element): void => {
    const selected = selectedFolderValues(picker);
    const pills = picker.querySelector("[data-quarry-search-folder-pills]");
    if (pills) {
        pills.innerHTML = renderFolderPills(selected);
    }
    const count = picker.querySelector("[data-quarry-search-folder-count]");
    if (count) {
        count.textContent = selected.includes("")
            ? "All folders selected"
            : `${selected.length} selected`;
    }
};

/** Open upward only when the panel doesn't fit below and there is more room above. */
export const shouldOpenUpward = (
    spaceAbove: number,
    spaceBelow: number,
    panelHeight: number,
    margin = 12,
): boolean => spaceBelow < panelHeight + margin && spaceAbove > spaceBelow;

const setPanelOpen = (picker: Element, open: boolean): void => {
    const panel = picker.querySelector<HTMLElement>(
        "[data-quarry-search-folder-panel]",
    );
    if (!panel) {
        return;
    }
    panel.hidden = !open;
    picker
        .querySelector("[data-quarry-search-folder-trigger]")
        ?.setAttribute("aria-expanded", String(open));
    if (open) {
        syncPicker(picker);
        // Measure AFTER unhiding: offsetHeight is 0 while hidden.
        panel.classList.remove("quarry-search-folder-panel-up");
        const trigger = picker.querySelector<HTMLElement>(
            "[data-quarry-search-folder-trigger]",
        );
        if (trigger) {
            const rect = trigger.getBoundingClientRect();
            if (
                shouldOpenUpward(
                    rect.top,
                    window.innerHeight - rect.bottom,
                    panel.offsetHeight,
                )
            ) {
                panel.classList.add("quarry-search-folder-panel-up");
            }
        }
        picker
            .querySelector<HTMLInputElement>(
                "[data-quarry-search-folder-filter]",
            )
            ?.focus();
    }
};

const closeAllPanels = (root: Document, except?: Element): void => {
    for (const picker of Array.from(
        root.querySelectorAll("[data-quarry-search-folder-picker]"),
    )) {
        if (picker !== except) {
            setPanelOpen(picker, false);
        }
    }
};

const applyFilter = (picker: Element, filterText: string): void => {
    const wanted = filterText.trim().toLowerCase();
    for (const label of Array.from(
        picker.querySelectorAll<HTMLElement>(".quarry-search-folder-option"),
    )) {
        const value =
            label.querySelector<HTMLInputElement>(
                "[data-quarry-search-folder-check]",
            )?.value ?? "";
        label.style.display =
            !wanted || value === "" || value.toLowerCase().includes(wanted)
                ? ""
                : "none";
    }
};

// --- Delegated event wiring --------------------------------------------------

let started = false;

/** Install document-level delegated handlers once, so added/re-rendered rows need no re-wiring. */
export const initFolderPickers = (root: Document): void => {
    if (started) {
        return;
    }
    started = true;

    root.addEventListener("click", (e) => {
        const target = e.target as HTMLElement | null;
        if (!target) {
            return;
        }
        const pillRemove = target.closest<HTMLElement>(
            "[data-quarry-search-folder-pill-remove]",
        );
        if (pillRemove) {
            const picker = pillRemove.closest(
                "[data-quarry-search-folder-picker]",
            );
            if (picker) {
                changeSelection(picker, pillRemove.dataset.value ?? "", false);
            }
            // Removing a pill must not toggle the panel underneath it.
            e.stopPropagation();
            return;
        }
        const trigger = target.closest("[data-quarry-search-folder-trigger]");
        if (trigger) {
            const picker = trigger.closest(
                "[data-quarry-search-folder-picker]",
            );
            if (picker) {
                const panel = picker.querySelector<HTMLElement>(
                    "[data-quarry-search-folder-panel]",
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
        const target = e.target as HTMLInputElement | null;
        if (!target?.matches?.("[data-quarry-search-folder-check]")) {
            return;
        }
        const picker = target.closest("[data-quarry-search-folder-picker]");
        if (picker) {
            changeSelection(picker, target.value, target.checked);
        }
    });

    root.addEventListener("input", (e) => {
        const target = e.target as HTMLInputElement | null;
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
            const openPicker = root
                .querySelector(
                    "[data-quarry-search-folder-panel]:not([hidden])",
                )
                ?.closest("[data-quarry-search-folder-picker]");
            openPicker
                ?.querySelector<HTMLElement>(
                    "[data-quarry-search-folder-trigger]",
                )
                ?.focus();
            closeAllPanels(root);
            return;
        }
        const target = e.target as HTMLElement | null;
        if (
            e.key === "Enter" &&
            target?.matches("[data-quarry-search-folder-filter]")
        ) {
            e.preventDefault();
        }
        if (
            (e.key === "Enter" || e.key === " ") &&
            target?.matches?.("[data-quarry-search-folder-trigger]")
        ) {
            e.preventDefault();
            target.click();
        }
    });
};
