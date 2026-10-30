import { querySections } from "./querysyntax";

const PROMPT_BOX_IDS = [
    "alt_prompt_textbox",
    "alt_negativeprompt_textbox",
    "input_prompt",
    "input_negativeprompt",
];
const referenceListeners = new Set<(names: string[]) => void>();
let referenceRequest = 0;
let referenceTimer: ReturnType<typeof setTimeout> | null = null;

export const recomputeReferences = (): void => {
    if (referenceTimer) clearTimeout(referenceTimer);
    referenceTimer = null;
    const request = ++referenceRequest;
    const prompt = PROMPT_BOX_IDS.map(
        (id) =>
            (document.getElementById(id) as HTMLTextAreaElement | null)
                ?.value ?? "",
    ).join("\n");
    const notify = (names: string[]): void => {
        if (request !== referenceRequest) return;
        for (const listener of referenceListeners) listener(names);
    };
    if (!/<q(?:\[|:)/i.test(prompt)) {
        notify([]);
        return;
    }
    genericRequest<{ success: boolean; names?: string[] }>(
        "QuarryResolveReferences",
        { prompt },
        (data) => {
            if (data.success) notify(data.names ?? []);
        },
    );
};

export const onReferences = (
    listener: (names: string[]) => void,
): (() => void) => {
    referenceListeners.add(listener);
    startPromptWatcher();
    recomputeReferences();
    return () => {
        referenceListeners.delete(listener);
    };
};

const scheduleReferences = (event: Event): void => {
    if (
        !(event.target instanceof HTMLTextAreaElement) ||
        !PROMPT_BOX_IDS.includes(event.target.id) ||
        !referenceListeners.size
    )
        return;
    ++referenceRequest;
    if (referenceTimer) clearTimeout(referenceTimer);
    referenceTimer = setTimeout(recomputeReferences, 250);
};

let watching = false;
let lastPromptBox: HTMLTextAreaElement | null = null;
export const startPromptWatcher = (): void => {
    if (watching) {
        return;
    }
    watching = true;
    document.addEventListener("input", scheduleReferences, true);
    document.addEventListener("change", scheduleReferences, true);
    document.addEventListener("focusin", (event) => {
        const target = event.target;
        if (
            target instanceof HTMLTextAreaElement &&
            PROMPT_BOX_IDS.includes(target.id)
        )
            lastPromptBox = target;
    });
};

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

const insertTag = (
    value: string,
    cursorPos: number,
    tag: string,
): PromptEdit => {
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
    return insertTag(value, cursorPos, `<q:${name}>`);
};

const editPrompt = (
    compute: (value: string, cursor: number) => PromptEdit,
): void => {
    let [promptBox, cursorPos] = lastPromptBox?.isConnected
        ? [lastPromptBox, lastPromptBox.selectionEnd]
        : uiImprover.getLastSelectedTextbox();
    if (!promptBox || promptBox.closest(".quarry-explore")) {
        promptBox = getRequiredElementById(
            "alt_prompt_textbox",
        ) as HTMLTextAreaElement;
        cursorPos = promptBox.value.length;
    }
    const edit = compute(promptBox.value, cursorPos);
    promptBox.value = edit.value;
    promptBox.selectionStart = edit.cursor;
    promptBox.selectionEnd = edit.cursor;
    promptBox.focus();
    triggerChangeFor(promptBox);
    if (referenceListeners.size) recomputeReferences();
};

export const insertQuarryTag = (name: string): void => {
    editPrompt((value, cursor) => computePromptEdit(value, cursor, name, true));
};

/** Insert an Explore draft as its own tag so its filters never affect other datasets. */
export const insertQuarryQuery = (query: string): void => {
    editPrompt((value, cursor) => insertTag(value, cursor, query));
};
