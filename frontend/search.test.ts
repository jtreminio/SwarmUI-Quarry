import { describe, expect, it } from "@jest/globals";
import {
    buildSearchRequest,
    loadMoreState,
    operatorsForType,
    opNeedsValue,
    resultsInfoText,
    rowToObject,
} from "./search";

describe("operatorsForType", () => {
    // The catalog is now served by the backend (single source of truth); the client just looks types up in it.
    const catalog = {
        text: [
            { value: "contains", label: "contains" },
            { value: "equals", label: "is" },
        ],
        number: [
            { value: "eq", label: "=" },
            { value: "ne", label: "≠" },
            { value: "gt", label: ">" },
        ],
    };
    it("returns the server-provided operators for a known type", () => {
        expect(operatorsForType(catalog, "number").map((o) => o.value)).toEqual(
            ["eq", "ne", "gt"],
        );
    });
    it("returns an empty list for a type missing from the catalog", () => {
        expect(operatorsForType(catalog, "bool")).toEqual([]);
    });
    it("returns an empty list when the catalog is empty", () => {
        expect(operatorsForType({}, "text")).toEqual([]);
    });
});

describe("opNeedsValue", () => {
    it("bool operators carry no value", () => {
        expect(opNeedsValue("is_true")).toBe(false);
        expect(opNeedsValue("is_false")).toBe(false);
    });
    it("every other operator needs a value", () => {
        expect(opNeedsValue("contains")).toBe(true);
        expect(opNeedsValue("ge")).toBe(true);
    });
});

describe("buildSearchRequest", () => {
    it("drops rows with a blank value on a value-needing operator", () => {
        expect(
            buildSearchRequest([
                { field: "prompt", op: "contains", value: "" },
            ]),
        ).toEqual([]);
    });
    it("keeps value-less bool rows and clears their value", () => {
        expect(
            buildSearchRequest([
                { field: "is_starred", op: "is_true", value: "ignored" },
            ]),
        ).toEqual([{ field: "is_starred", op: "is_true", value: "" }]);
    });
    it("keeps complete rows verbatim", () => {
        expect(
            buildSearchRequest([
                { field: "model", op: "contains", value: "sdxl" },
            ]),
        ).toEqual([{ field: "model", op: "contains", value: "sdxl" }]);
    });
    it("drops rows missing a field or operator", () => {
        expect(
            buildSearchRequest([
                { field: "", op: "contains", value: "x" },
                { field: "model", op: "", value: "x" },
            ]),
        ).toEqual([]);
    });
});

describe("rowToObject", () => {
    it("zips column names to row values", () => {
        expect(rowToObject(["path", "model"], ["a.png", "sdxl"])).toEqual({
            path: "a.png",
            model: "sdxl",
        });
    });
    it("fills missing trailing values with empty strings", () => {
        expect(rowToObject(["a", "b"], ["x"])).toEqual({ a: "x", b: "" });
    });
});

describe("resultsInfoText", () => {
    it("is empty until an index exists", () => {
        expect(resultsInfoText(false, 0, 0)).toBe("");
    });
    it("reports when nothing matches", () => {
        expect(resultsInfoText(true, 0, 0)).toBe("No matching images.");
    });
    it("shows the loaded-vs-total count when more remain", () => {
        expect(resultsInfoText(true, 2000, 2640)).toBe(
            "Showing 2000 of 2640 matches.",
        );
    });
    it("shows a plain total once everything is loaded", () => {
        expect(resultsInfoText(true, 2640, 2640)).toBe("2640 matches.");
    });
    it("uses the singular for a single match", () => {
        expect(resultsInfoText(true, 1, 1)).toBe("1 match.");
    });
});

describe("loadMoreState", () => {
    it("is hidden without an index", () => {
        expect(loadMoreState(true, false, 0, 0, 1000, false).visible).toBe(
            false,
        );
    });
    it("is hidden when everything matching is loaded", () => {
        expect(loadMoreState(true, true, 2640, 2640, 1000, false).visible).toBe(
            false,
        );
    });
    it("is hidden when the feature is unavailable", () => {
        expect(loadMoreState(false, true, 0, 2640, 1000, false).visible).toBe(
            false,
        );
    });
    it("advertises the next page size and remaining count", () => {
        const state = loadMoreState(true, true, 2000, 2640, 1000, false);
        expect(state.visible).toBe(true);
        expect(state.disabled).toBe(false);
        expect(state.label).toBe("Load 640 more (640 remaining)");
    });
    it("caps the next page at the page size", () => {
        expect(loadMoreState(true, true, 0, 2640, 1000, false).label).toBe(
            "Load 1000 more (2640 remaining)",
        );
    });
    it("disables and relabels while a fetch is busy", () => {
        const state = loadMoreState(true, true, 2000, 2640, 1000, true);
        expect(state.disabled).toBe(true);
        expect(state.label).toBe("Loading…");
    });
});
