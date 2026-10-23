import { beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import {
    initFolderPickers,
    renderFolderPicker,
    selectedFolderValues,
    syncPicker,
} from "./folderPicker";

const options = ["Grids", "Starred", "raw", "raw/2026", "raw/2025"];
const boxes = (): HTMLInputElement[] =>
    Array.from(
        document.querySelectorAll<HTMLInputElement>(
            "[data-quarry-search-folder-check]",
        ),
    );
const required = <T>(value: T | null | undefined): T => {
    if (value == null) {
        throw new Error("Expected picker element");
    }
    return value;
};
const box = (value: string): HTMLInputElement =>
    required(boxes().find((input) => input.value === value));
const panel = (): HTMLElement =>
    required(
        document.querySelector<HTMLElement>(
            "[data-quarry-search-folder-panel]",
        ),
    );
const click = (selector: string): void =>
    required(document.querySelector<HTMLElement>(selector)).click();
const selection = (): string[] => selectedFolderValues(document.body);
const render = (selected: string[]): void => {
    document.body.innerHTML = renderFolderPicker(selected, options);
    syncPicker(document.body);
};

describe("image search folder picker", () => {
    beforeAll(() => initFolderPickers(document));
    beforeEach(() => render([]));

    it("selects every folder through All and keeps the panel open", () => {
        click("[data-quarry-search-folder-trigger]");
        box("").click();
        expect(boxes().every((input) => input.checked)).toBe(true);
        expect(selection()).toEqual([""]);
        expect(panel().hidden).toBe(false);
        expect(
            document.querySelector("[data-quarry-search-folder-count]")
                ?.textContent,
        ).toBe("All folders selected");
    });

    it("supports multiple folders and checks descendants of selected parents", () => {
        box("raw").click();
        box("Starred").click();
        expect(box("raw/2026").checked).toBe(true);
        expect(box("raw/2025").checked).toBe(true);
        expect(selection()).toEqual(["Starred", "raw"]);
    });

    it("clears All and the parent when a descendant is unchecked", () => {
        render([""]);
        box("raw/2026").click();
        expect(box("").checked).toBe(false);
        expect(box("raw").checked).toBe(false);
        expect(selection()).toEqual(["Grids", "Starred", "raw/2025"]);
    });

    it("removes a parent chip with its descendants without opening the panel", () => {
        render(["raw", "Starred"]);
        click('[data-quarry-search-folder-pill-remove][data-value="raw"]');
        expect(selection()).toEqual(["Starred"]);
        expect(box("raw/2026").checked).toBe(false);
        expect(panel().hidden).toBe(true);
    });

    it("clears all selections without reverting to All", () => {
        render([""]);
        click("[data-quarry-search-folder-clear]");
        expect(selection()).toEqual([]);
        expect(boxes().every((input) => !input.checked)).toBe(true);
        expect(
            document.querySelector("[data-quarry-search-folder-pills]")
                ?.textContent,
        ).toBe("No folders selected");
    });

    it("filters folder names while retaining All and existing selections", () => {
        render(["Starred"]);
        const filter = required(
            document.querySelector<HTMLInputElement>(
                "[data-quarry-search-folder-filter]",
            ),
        );
        filter.value = "2026";
        filter.dispatchEvent(new Event("input", { bubbles: true }));
        expect(box("Starred").closest("label")?.style.display).toBe("none");
        expect(box("raw/2026").closest("label")?.style.display).toBe("");
        expect(box("").closest("label")?.style.display).toBe("");
        expect(selection()).toEqual(["Starred"]);
    });

    it("supports keyboard opening, Escape, and outside-click closing", () => {
        const trigger = required(
            document.querySelector<HTMLElement>(
                "[data-quarry-search-folder-trigger]",
            ),
        );
        trigger.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
        expect(panel().hidden).toBe(false);
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
        expect(panel().hidden).toBe(true);
        expect(document.activeElement).toBe(trigger);
        trigger.click();
        document.body.click();
        expect(panel().hidden).toBe(true);
    });

    it("escapes folder names and restores saved selections", () => {
        const name = 'raw/<img src=x onerror="bad()">';
        document.body.innerHTML = renderFolderPicker([name], [name]);
        expect(document.querySelector("img")).toBeNull();
        expect(selection()).toEqual([name]);
    });

    it("removes unavailable saved folders from both chips and options", () => {
        document.body.innerHTML = renderFolderPicker(
            ["deleted", "restricted", "Starred"],
            options,
        );
        expect(document.body.textContent).not.toContain("deleted");
        expect(document.body.textContent).not.toContain("restricted");
        expect(boxes().map((input) => input.value)).toEqual(["", ...options]);
        expect(selection()).toEqual(["Starred"]);
    });

    it("does not select All or descendants when all saved folders are unavailable", () => {
        document.body.innerHTML = renderFolderPicker(
            ["restricted"],
            ["restricted/allowed"],
        );
        expect(selection()).toEqual([]);
        expect(
            document.querySelector("[data-quarry-search-folder-pills]")
                ?.textContent,
        ).toBe("No folders selected");
        expect(boxes().every((input) => !input.checked)).toBe(true);
    });
});
