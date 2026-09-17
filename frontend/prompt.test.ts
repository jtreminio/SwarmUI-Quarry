import { afterEach, describe, expect, it } from "@jest/globals";
import {
    computePromptEdit,
    getAddToExistingTag,
    setAddToExistingTag,
} from "./prompt";

// computePromptEdit(value, cursorPos, name, addToExisting) is the pure core of a dataset-name click: it decides
// whether to insert, toggle-off, or append to an existing tag, and returns the new prompt text + caret.
describe("computePromptEdit — insert (separate, the default)", () => {
    it("preserves nested selectors and quoted options when toggling datasets", () => {
        const tail =
            '[subject[i].hair=blond]:subject[i], subject[]|keys; rs=" = ; [] "; fs=", "';
        const added = computePromptEdit(`<q:A${tail}>`, 0, "B", true).value;
        expect(added).toBe(`<q:A,B${tail}>`);
        expect(computePromptEdit(added, 0, "A", true).value).toBe(
            `<q:B${tail}>`,
        );
        expect(computePromptEdit('<q:A|keys;rs=";">', 0, "B", true).value).toBe(
            '<q:A,B|keys;rs=";">',
        );
    });
    it("preserves output columns when adding and removing datasets", () => {
        const original = "<q:A[tags=goth]:appearance, clothing,pose>";
        const added = computePromptEdit(original, 0, "B", true).value;
        expect(added).toBe("<q:A,B[tags=goth]:appearance, clothing,pose>");
        expect(computePromptEdit(added, 0, "A", true).value).toBe(
            "<q:B[tags=goth]:appearance, clothing,pose>",
        );
    });

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

    it("boils a filtered tag down to an empty <q:[filter]> when its only dataset is clicked", () => {
        // The query is worth keeping even with no dataset left, so the tag is not dropped — it becomes an
        // empty `<q:[filter]>` shell that a later dataset click re-fills. (See the dedicated describe below.)
        expect(computePromptEdit("<q:A[tags=x]>", 0, "A", false)).toEqual({
            value: "<q:[tags=x]>",
            cursor: 12,
        });
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
        // The last dataset leaving keeps the query as an empty `<q:[filter]>` shell rather than vanishing.
        expect(
            computePromptEdit(
                "<q:Aconexx.CivitAI-Flux-Prompts[tags=girl]>",
                0,
                "Aconexx.CivitAI-Flux-Prompts",
                true,
            ).value,
        ).toBe("<q:[tags=girl]>");
    });
});

describe("computePromptEdit — prompt-column suffix is preserved", () => {
    it("appends to a column tag, keeping the :column at the end (<q:A:c> + B -> <q:A,B:c>)", () => {
        expect(computePromptEdit("<q:A:c>", 7, "B", true).value).toBe(
            "<q:A,B:c>",
        );
    });

    it("appends into a filtered column tag (<q:A[tags=x]:c> + B -> <q:A,B[tags=x]:c>)", () => {
        expect(computePromptEdit("<q:A[tags=x]:c>", 15, "B", true).value).toBe(
            "<q:A,B[tags=x]:c>",
        );
    });

    it("drops one name from a column tag, keeping the :column (<q:A,B:c> - A -> <q:B:c>)", () => {
        expect(computePromptEdit("<q:A,B:c>", 0, "A", false).value).toBe(
            "<q:B:c>",
        );
    });

    it("removes a whole column tag when its only dataset is clicked", () => {
        expect(computePromptEdit("<q:A:c>", 0, "A", false).value).toBe("");
    });

    it("does not treat a `:` inside a filter value as a column suffix", () => {
        // <q:A[url=http://x]> + B must still merge as a plain filtered tag, leaving the value's `:` alone.
        expect(
            computePromptEdit("<q:A[url=http://x]>", 19, "B", true).value,
        ).toBe("<q:A,B[url=http://x]>");
    });
});

// Removing the last dataset from a filtered tag keeps an "empty" `<q:[filter]>` so the carefully-built query
// survives and a later dataset click re-fills it — instead of starting a fresh, filter-less tag.
describe("computePromptEdit — boil down to an empty filtered tag", () => {
    it("keeps the [filter] when the last dataset is removed (the boil-down)", () => {
        expect(computePromptEdit("<q:A[tags=x]>", 0, "A", true).value).toBe(
            "<q:[tags=x]>",
        );
    });

    it("still drops a no-filter tag entirely (only a kept query survives)", () => {
        expect(computePromptEdit("<q:A>", 0, "A", true).value).toBe("");
    });

    it("preserves the [count] prefix while boiling down", () => {
        expect(computePromptEdit("<q[3]:A[tags=x]>", 0, "A", true).value).toBe(
            "<q[3]:[tags=x]>",
        );
    });

    it("preserves the :column suffix while boiling down", () => {
        expect(computePromptEdit("<q:A[tags=x]:cap>", 0, "A", true).value).toBe(
            "<q:[tags=x]:cap>",
        );
    });

    it("walks a two-dataset filtered tag down to an empty shell, one click at a time", () => {
        // The reported flow: <q:A,B[...]> -> remove B -> <q:A[...]> -> remove A -> <q:[...]>.
        const filter = "[tags=woman; tags!=buzz; prompt!=buzz]";
        const afterB = computePromptEdit(`<q:A,B${filter}>`, 0, "B", true);
        expect(afterB.value).toBe(`<q:A${filter}>`);
        const afterA = computePromptEdit(afterB.value, 0, "A", true);
        expect(afterA.value).toBe(`<q:${filter}>`);
    });

    it("re-fills an empty filtered tag when a dataset is clicked (add-to-existing on)", () => {
        // The whole point: clicking C onto `<q:[tags=x]>` rebuilds it as `<q:C[tags=x]>`, query intact, rather
        // than opening a separate tag.
        expect(computePromptEdit("<q:[tags=x]>", 12, "C", true).value).toBe(
            "<q:C[tags=x]>",
        );
    });

    it("round-trips a real dotted name + multi-clause filter down to an empty shell and back", () => {
        const filter = "[tags=woman; tags!=buzz; prompt!=buzz]";
        const start = `<q:Aconexx.CivitAI-Flux-Prompts,AlekseyKorshuk.midjourney-prompts-text-dedup${filter}>`;
        const dropSecond = computePromptEdit(
            start,
            0,
            "AlekseyKorshuk.midjourney-prompts-text-dedup",
            true,
        );
        expect(dropSecond.value).toBe(
            `<q:Aconexx.CivitAI-Flux-Prompts${filter}>`,
        );
        const dropFirst = computePromptEdit(
            dropSecond.value,
            0,
            "Aconexx.CivitAI-Flux-Prompts",
            true,
        );
        expect(dropFirst.value).toBe(`<q:${filter}>`);
        // Clicking a new dataset re-fills the kept query.
        expect(
            computePromptEdit(
                dropFirst.value,
                0,
                "wtcherr.midjourney-prompts",
                true,
            ).value,
        ).toBe(`<q:wtcherr.midjourney-prompts${filter}>`);
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
