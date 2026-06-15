import { afterEach, describe, expect, it } from "@jest/globals";
import {
    computePromptEdit,
    getAddToExistingTag,
    setAddToExistingTag,
} from "./prompt";

// computePromptEdit(value, cursorPos, name, addToExisting) is the pure core of a dataset-name click: it decides
// whether to insert, toggle-off, or append to an existing tag, and returns the new prompt text + caret.
describe("computePromptEdit — insert (separate, the default)", () => {
    it("inserts a <q:NAME> tag into an empty prompt", () => {
        expect(computePromptEdit("", 0, "A", false)).toEqual({
            value: "<q:A>",
            cursor: 5,
        });
    });

    it("appends after existing text at the cursor", () => {
        expect(computePromptEdit("hello", 5, "A", false)).toEqual({
            value: "hello <q:A>",
            cursor: 11,
        });
    });

    it("inserts at the cursor in the middle, reflowing spaces", () => {
        expect(computePromptEdit("a b", 1, "A", false)).toEqual({
            value: "a <q:A> b",
            cursor: 7,
        });
    });
});

describe("computePromptEdit — toggle off (the duplicate-click fix)", () => {
    it("removes a standalone reference instead of adding it again", () => {
        // The reported bug: clicking A, then B, then A must drop A — not add a second <q:A>.
        expect(computePromptEdit("<q:A> <q:B>", 11, "A", false)).toEqual({
            value: "<q:B>",
            cursor: 0,
        });
    });

    it("clicking an already-present dataset removes it (full round trip)", () => {
        // Reproduce the click sequence end to end: "" -> A -> B -> A.
        const afterA = computePromptEdit("", 0, "A", false);
        expect(afterA.value).toBe("<q:A>");
        const afterB = computePromptEdit(
            afterA.value,
            afterA.cursor,
            "B",
            false,
        );
        expect(afterB.value).toBe("<q:A> <q:B>");
        const afterAAgain = computePromptEdit(
            afterB.value,
            afterB.cursor,
            "A",
            false,
        );
        // Not "<q:A> <q:B> <q:A>" — A is toggled off.
        expect(afterAAgain.value).toBe("<q:B>");
    });

    it("drops just the clicked dataset from a comma list", () => {
        expect(computePromptEdit("<q:A,B>", 0, "A", false)).toEqual({
            value: "<q:B>",
            cursor: 5,
        });
        expect(computePromptEdit("<q:A,B>", 0, "B", false).value).toBe("<q:A>");
    });

    it("matches dataset names case-insensitively", () => {
        expect(computePromptEdit("<q:DataSetA>", 0, "dataseta", false)).toEqual(
            {
                value: "",
                cursor: 0,
            },
        );
    });

    it("preserves a [count] prefix when removing one of several names", () => {
        expect(computePromptEdit("<q[3]:A,B>", 0, "A", false).value).toBe(
            "<q[3]:B>",
        );
    });

    it("preserves a [filter] suffix when removing one of several names", () => {
        expect(computePromptEdit("<q:A,B[tags=x]>", 0, "A", false).value).toBe(
            "<q:B[tags=x]>",
        );
    });

    it("removes a filtered tag entirely when its only dataset is clicked", () => {
        expect(computePromptEdit("<q:A[tags=x]>", 0, "A", false).value).toBe(
            "",
        );
    });

    it("collapses surrounding text to a single space when dropping a tag", () => {
        expect(computePromptEdit("red <q:A> blue", 14, "A", false)).toEqual({
            value: "red blue",
            cursor: 3,
        });
    });
});

describe("computePromptEdit — add to existing tag", () => {
    it("appends to the first existing plain tag (<q:A> + B -> <q:A,B>)", () => {
        expect(computePromptEdit("<q:A>", 5, "B", true)).toEqual({
            value: "<q:A,B>",
            cursor: 7,
        });
    });

    it("inserts a separate tag when no <q:...> tag exists yet", () => {
        expect(computePromptEdit("hello", 5, "A", true).value).toBe(
            "hello <q:A>",
        );
    });

    it("appends into a filtered tag, before the filter (the only valid combined form)", () => {
        // The whole point of "add to existing tag": <q:A[tags=x]> + B must become <q:A,B[tags=x]>, NOT a
        // separate tag (and never a cursor insert that could split the tag into malformed nested tags).
        expect(computePromptEdit("<q:A[tags=x]>", 13, "B", true).value).toBe(
            "<q:A,B[tags=x]>",
        );
    });

    it("appends real dotted dataset names into a filtered tag", () => {
        expect(
            computePromptEdit(
                "<q:Aconexx.CivitAI-Flux-Prompts[tags=girl]>",
                43,
                "wtcherr.midjourney-prompts",
                true,
            ).value,
        ).toBe(
            "<q:Aconexx.CivitAI-Flux-Prompts,wtcherr.midjourney-prompts[tags=girl]>",
        );
    });

    it("appends to the first tag even when it is filtered", () => {
        expect(computePromptEdit("<q:C[f=1]> <q:A>", 16, "B", true).value).toBe(
            "<q:C,B[f=1]> <q:A>",
        );
    });

    it("still toggles a present dataset off (removal beats appending)", () => {
        expect(computePromptEdit("<q:A,B>", 0, "A", true).value).toBe("<q:B>");
    });

    it("toggles a dataset off from inside a filtered tag", () => {
        // Regression: a filtered tag must still be recognized on re-click, so it's removed (not re-appended).
        expect(
            computePromptEdit(
                "<q:Aconexx.CivitAI-Flux-Prompts[tags=girl]>",
                0,
                "Aconexx.CivitAI-Flux-Prompts",
                true,
            ).value,
        ).toBe("");
    });
});

describe("add-to-existing-tag preference", () => {
    afterEach(() => {
        setAddToExistingTag(true);
    });

    it("defaults to on", () => {
        expect(getAddToExistingTag()).toBe(true);
    });

    it("reflects the last set value", () => {
        setAddToExistingTag(true);
        expect(getAddToExistingTag()).toBe(true);
        setAddToExistingTag(false);
        expect(getAddToExistingTag()).toBe(false);
    });
});
