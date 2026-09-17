import { querySections } from "./querysyntax";
import type { ReferencesResponse } from "./types";

const HIGHLIGHT_DEBOUNCE_MS = 250;
const PROMPT_BOX_IDS = ["alt_prompt_textbox", "alt_negativeprompt_textbox"];
const Q_TAG_GUARD = /<q(?:\[|:)/i;

type ReferencesListener = (names: string[]) => void;

const listeners: ReferencesListener[] = [];
let lastNames: string[] = [];

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

const readPromptText = (): string =>
    PROMPT_BOX_IDS.map(
        (id) =>
            (document.getElementById(id) as HTMLTextAreaElement | null)
                ?.value ?? "",
    ).join("\n");

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
export const startPromptWatcher = (): void => {
    if (watching) {
        return;
    }
    watching = true;
    for (const id of PROMPT_BOX_IDS) {
        document.getElementById(id)?.addEventListener("input", schedule);
    }
};

let addToExistingTag = true;
export const setAddToExistingTag = (value: boolean): void => {
    addToExistingTag = value;
};

export const getAddToExistingTag = (): boolean => addToExistingTag;
const Q_TAG_PATTERN = "<(q(?:\\[\\d+(?:-\\d+)?\\])?):([^>]*)>";

interface QuarryTag {
    start: number;
    end: number;
    keyword: string;
    names: string[];
    filter: string;
    column: string;
}

export interface PromptEdit {
    value: string;
    cursor: number;
}

const splitTagInner = (
    inner: string,
): { names: string[]; filter: string; column: string } => {
    const sections = querySections(inner);
    const boundary = sections.colon >= 0 ? sections.colon : sections.pipe;
    const head = boundary < 0 ? inner : inner.slice(0, boundary);
    const column = boundary < 0 ? "" : inner.slice(boundary);
    const bracket = head.indexOf("[");
    const namesPart = bracket < 0 ? head : head.slice(0, bracket);
    const filter = bracket < 0 ? "" : head.slice(bracket);
    const names = namesPart
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    return { names, filter, column };
};

const findQuarryTags = (value: string): QuarryTag[] => {
    const regex = new RegExp(Q_TAG_PATTERN, "gi");
    const tags: QuarryTag[] = [];
    let match: RegExpExecArray | null = regex.exec(value);
    while (match !== null) {
        const { names, filter, column } = splitTagInner(match[2]);
        tags.push({
            start: match.index,
            end: match.index + match[0].length,
            keyword: match[1],
            names,
            filter,
            column,
        });
        match = regex.exec(value);
    }
    return tags;
};

const buildTag = (tag: QuarryTag, names: string[]): string =>
    `<${tag.keyword}:${names.join(",")}${tag.filter}${tag.column}>`;

const trimSpacesOnly = (text: string): string => text.replace(/^ +| +$/g, "");

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
        if (remaining.length > 0 || tag.filter.length > 0) {
            const rebuilt = buildTag(tag, remaining);
            return {
                value:
                    value.slice(0, tag.start) + rebuilt + value.slice(tag.end),
                cursor: tag.start + rebuilt.length,
            };
        }
        const before = value.slice(0, tag.start).replace(/ +$/, "");
        const after = value.slice(tag.end).replace(/^ +/, "");
        const joiner = before.length > 0 && after.length > 0 ? " " : "";
        return { value: before + joiner + after, cursor: before.length };
    }
    return null;
};

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
