declare function genericRequest<T = unknown>(
    endpoint: string,
    data: Record<string, unknown>,
    callback: (data: T) => void,
): void;

interface QuarryJQuery {
    modal(action: "show" | "hide"): void;
}

declare function $(selector: string | Element): QuarryJQuery;

// --- SwarmUI core globals used by the Quarry tab ---

declare function getRequiredElementById(id: string): HTMLElement;
declare function triggerChangeFor(elem: HTMLElement): void;
declare function trimSpaces(text: string): string;
declare function regexEscape(text: string): string;

// SwarmUI core's prompt-tab autocompleter (genpage/gentab/prompttools.js), constructed before extension scripts
// run. Quarry registers a `q` prefix on it (complete.ts) so `<q:...>` tags get dataset/column suggestions; only
// the registration surface is declared here. A completer returns the popover entries (raw objects, for Quarry).
declare const promptTabComplete: {
    registerPrefix(
        name: string,
        description: string,
        completer: (suffix: string, prompt: string) => unknown[],
        selfStanding?: boolean,
    ): void;
};

declare const uiImprover: {
    getLastSelectedTextbox(): [HTMLTextAreaElement | null, number];
};

declare const browserUtil: {
    makeVisible(elem: Element | Document): void;
};

interface GenTabLayoutLike {
    managedTabs: MovableGenTab[];
    managedTabContainers: Element[];
    reapplyPositions(): void;
}

// The generate tab's layout manager (layout.js); constructed before extension scripts run.
declare const genTabLayout: GenTabLayoutLike;

// One movable sub-tab; constructing it wires up the custom (non-bootstrap) click handling.
declare class MovableGenTab {
    constructor(navLink: Element, handler: GenTabLayoutLike);
    contentElem: HTMLElement;
    navElem: HTMLElement;
    update(): void;
}
