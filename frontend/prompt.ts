// Shared prompt plumbing for both the settings table and the Quarry browser tab:
//  - watches the positive/negative prompt boxes and resolves which datasets they reference,
//  - inserts / toggles a `<q:NAME>` tag at the cursor when a dataset is clicked.

import type { ReferencesResponse } from "./types";

// Debounce prompt edits before asking the backend which datasets are referenced.
const HIGHLIGHT_DEBOUNCE_MS = 250;
// SwarmUI core's positive + negative prompt textareas (live in the page even when the Quarry tab is shown).
const PROMPT_BOX_IDS = ["alt_prompt_textbox", "alt_negativeprompt_textbox"];
// Cheap guard: only hit the backend when the prompt actually contains a `<q:` or `<q[count]:` tag.
const Q_TAG_GUARD = /<q(?:\[|:)/i;

type ReferencesListener = (names: string[]) => void;

const listeners: ReferencesListener[] = [];
// The most recent set of referenced dataset names, replayed to every new subscriber.
let lastNames: string[] = [];

/// Subscribes to changes in which datasets the current prompt references. The listener is invoked immediately
/// with the last known set so a freshly-built view starts in sync.
export const onReferences = (listener: ReferencesListener): void => {
    listeners.push(listener);
    listener(lastNames);
};

const notify = (names: string[]): void => {
    lastNames = names;
    for (const listener of listeners) {
        listener(names);
    }
};

// The combined positive + negative prompt text, so a reference in either is detected.
const readPromptText = (): string =>
    PROMPT_BOX_IDS.map(
        (id) =>
            (document.getElementById(id) as HTMLTextAreaElement | null)
                ?.value ?? "",
    ).join("\n");

/// Re-resolves the datasets referenced by the current prompt and notifies subscribers. Skips the backend
/// round-trip (clearing everything) when the prompt has no `<q:` tag — the common case.
export const recomputeReferences = (): void => {
    const prompt = readPromptText();
    if (!Q_TAG_GUARD.test(prompt)) {
        notify([]);
        return;
    }
    genericRequest<ReferencesResponse>(
        "QuarryResolveReferences",
        { prompt },
        (data) => {
            if (data.success) {
                notify(data.names ?? []);
            }
        },
    );
};

let highlightTimer: ReturnType<typeof setTimeout> | null = null;
const schedule = (): void => {
    if (highlightTimer) {
        clearTimeout(highlightTimer);
    }
    highlightTimer = setTimeout(recomputeReferences, HIGHLIGHT_DEBOUNCE_MS);
};

let watching = false;
/// Starts watching the prompt boxes for edits (idempotent).
export const startPromptWatcher = (): void => {
    if (watching) {
        return;
    }
    watching = true;
    for (const id of PROMPT_BOX_IDS) {
        document.getElementById(id)?.addEventListener("input", schedule);
    }
};

// --- Tag editing: clicking a dataset name inserts / toggles a `<q:NAME>` reference in the prompt ---

// Whether clicking a dataset name appends it to the prompt's first existing `<q:...>` tag instead of inserting
// a separate one. Mirrors the server-persisted setting; settings.ts keeps it in sync (on load and on the
// checkbox's change), and insertQuarryTag reads it at click time.
let addToExistingTag = true;

/// Sets the in-memory "add to existing tag" preference that drives click behavior.
export const setAddToExistingTag = (value: boolean): void => {
    addToExistingTag = value;
};

/// The current "add to existing tag" preference.
export const getAddToExistingTag = (): boolean => addToExistingTag;

// Mirrors the backend reference matcher (PromptTagHandler.ReferenceTagRegex): an optional `[count]` / `[n-m]`
// after `q`, then the inner `NAME-list[filter]`. Reserved chars `< >` can't appear inside, so `[^>]*` is safe.
const Q_TAG_PATTERN = "<(q(?:\\[\\d+(?:-\\d+)?\\])?):([^>]*)>";

interface QuarryTag {
    start: number; // index of the opening `<`
    end: number; // index just past the closing `>`
    keyword: string; // `q`, `q[3]`, `q[1-4]`, … — preserved when the tag is rewritten
    names: string[]; // the comma-separated dataset names, before any `[filter]`
    filter: string; // the `[...]` suffix, or "" when the tag has none
}

/// The result of a dataset-name click: the new prompt text and where to put the caret.
export interface PromptEdit {
    value: string;
    cursor: number;
}

// Splits a tag's inner content into its dataset-name list and its (optional) `[filter]` suffix.
const splitTagInner = (inner: string): { names: string[]; filter: string } => {
    const bracket = inner.indexOf("[");
    const namesPart = bracket < 0 ? inner : inner.slice(0, bracket);
    const filter = bracket < 0 ? "" : inner.slice(bracket);
    const names = namesPart
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    return { names, filter };
};

// Every `<q:...>` tag in `value`, in order of appearance.
const findQuarryTags = (value: string): QuarryTag[] => {
    const regex = new RegExp(Q_TAG_PATTERN, "gi");
    const tags: QuarryTag[] = [];
    let match: RegExpExecArray | null = regex.exec(value);
    while (match !== null) {
        const { names, filter } = splitTagInner(match[2]);
        tags.push({
            start: match.index,
            end: match.index + match[0].length,
            keyword: match[1],
            names,
            filter,
        });
        match = regex.exec(value);
    }
    return tags;
};

// Rebuilds a tag with a new name list, preserving its keyword (count) and filter.
const buildTag = (tag: QuarryTag, names: string[]): string =>
    `<${tag.keyword}:${names.join(",")}${tag.filter}>`;

// Trims only ASCII spaces (matching core's trimSpaces), so tabs/newlines in multi-line prompts survive.
const trimSpacesOnly = (text: string): string => text.replace(/^ +| +$/g, "");

// If `name` is referenced by any `<q:...>` tag, returns the prompt with it removed — dropping the whole tag
// when it was the tag's only dataset — else null. Case-insensitive exact-name match against the canonical name
// the button inserts; it does not try to edit globs or fuzzy references.
const removeDatasetFromValue = (
    value: string,
    name: string,
): PromptEdit | null => {
    const lower = name.toLowerCase();
    for (const tag of findQuarryTags(value)) {
        const index = tag.names.findIndex((n) => n.toLowerCase() === lower);
        if (index < 0) {
            continue;
        }
        const remaining = tag.names.filter((_, i) => i !== index);
        if (remaining.length > 0) {
            const rebuilt = buildTag(tag, remaining);
            return {
                value:
                    value.slice(0, tag.start) + rebuilt + value.slice(tag.end),
                cursor: tag.start + rebuilt.length,
            };
        }
        // The tag had only this dataset — drop it, collapsing the gap it leaves to a single space.
        const before = value.slice(0, tag.start).replace(/ +$/, "");
        const after = value.slice(tag.end).replace(/^ +/, "");
        const joiner = before.length > 0 && after.length > 0 ? " " : "";
        return { value: before + joiner + after, cursor: before.length };
    }
    return null;
};

// Appends `name` to the first `<q:...>` tag in the prompt, before any `[filter]` — so `<q:A[tags=x]>` becomes
// `<q:A,B[tags=x]>`. A filtered tag's name list and its filter are both edited in place (the appended dataset
// shares the filter, the only valid way the `<q:>` grammar can combine datasets under one). This must handle
// filtered tags too: skipping them and falling back to a cursor insert can split a tag mid-text into malformed
// nested tags. Returns null only when the prompt has no `<q:...>` tag at all.
const addDatasetToFirstTag = (
    value: string,
    name: string,
): PromptEdit | null => {
    const [target] = findQuarryTags(value);
    if (!target) {
        return null;
    }
    const rebuilt = buildTag(target, [...target.names, name]);
    return {
        value: value.slice(0, target.start) + rebuilt + value.slice(target.end),
        cursor: target.start + rebuilt.length,
    };
};

// Inserts a fresh `<q:NAME>` at the cursor, reflowing surrounding spaces like core's wildcard insert.
const insertNewTag = (
    value: string,
    cursorPos: number,
    name: string,
): PromptEdit => {
    const tag = `<q:${name}>`;
    const prefix = trimSpacesOnly(value.slice(0, cursorPos));
    const suffix = trimSpacesOnly(value.slice(cursorPos));
    if (prefix.length > 0 && suffix.length > 0) {
        return {
            value: `${prefix} ${tag} ${suffix}`,
            cursor: prefix.length + 1 + tag.length,
        };
    }
    if (prefix.length > 0) {
        return {
            value: `${prefix} ${tag}`,
            cursor: prefix.length + 1 + tag.length,
        };
    }
    if (suffix.length > 0) {
        return { value: `${tag} ${suffix}`, cursor: tag.length };
    }
    return { value: tag, cursor: tag.length };
};

/// Decides how a dataset-name click edits the prompt: toggle the dataset off if it's already referenced, else
/// (in "add to existing tag" mode) append it to the first existing `<q:...>` tag, else insert a new `<q:NAME>`
/// at the cursor. Pure (no DOM) so it is unit-tested directly.
export const computePromptEdit = (
    value: string,
    cursorPos: number,
    name: string,
    addToExisting: boolean,
): PromptEdit => {
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

/// Inserts or toggles a `<q:NAME>` reference for the clicked dataset in whichever prompt box was last focused
/// (positive by default). Clicking a dataset already referenced removes it (so a repeat click never duplicates
/// it); otherwise it's added — appended to the first existing `<q:...>` tag when "add to existing tag" is on,
/// or inserted as a new tag at the cursor.
export const insertQuarryTag = (name: string): void => {
    let [promptBox, cursorPos] = uiImprover.getLastSelectedTextbox();
    if (!promptBox) {
        promptBox = getRequiredElementById(
            "alt_prompt_textbox",
        ) as HTMLTextAreaElement;
        cursorPos = promptBox.value.length;
    }
    const edit = computePromptEdit(
        promptBox.value,
        cursorPos,
        name,
        addToExistingTag,
    );
    promptBox.value = edit.value;
    promptBox.selectionStart = edit.cursor;
    promptBox.selectionEnd = edit.cursor;
    promptBox.focus();
    triggerChangeFor(promptBox);
    recomputeReferences();
};
