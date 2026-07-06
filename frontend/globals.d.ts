declare function genericRequest<T = unknown>(
    endpoint: string,
    data: Record<string, unknown>,
    callback: (data: T) => void,
    depth?: number,
    errorHandle?: ((error: unknown) => void) | null,
): void;

interface QuarryJQuery {
    modal(action: "show" | "hide"): void;
}

declare function $(selector: string | Element): QuarryJQuery;

declare function getRequiredElementById(id: string): HTMLElement;
declare function triggerChangeFor(elem: HTMLElement): void;
declare function trimSpaces(text: string): string;
declare function regexEscape(text: string): string;
declare function copyText(text: string): void;
declare function doNoticePopover(
    text: string,
    className: string,
    targetX?: number,
    targetY?: number,
): void;

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

declare function getImageOutPrefix(): string;

interface GenTabLayoutLike {
    managedTabs: MovableGenTab[];
    managedTabContainers: Element[];
    reapplyPositions(): void;
}

declare const genTabLayout: GenTabLayoutLike;
// One movable sub-tab; constructing it wires up the custom (non-bootstrap) click handling.
declare class MovableGenTab {
    constructor(navLink: Element, handler: GenTabLayoutLike);
    contentElem: HTMLElement;
    navElem: HTMLElement;
    update(): void;
}

interface BrowserFile {
    name: string;
    data: {
        src: string;
        fullsrc: string;
        name: string;
        metadata: string;
    };
}

declare class GenPageBrowserClass {
    constructor(
        container: string,
        listFoldersAndFiles: (
            folder: string,
            isRefresh: boolean,
            callback: (folders: string[], files: BrowserFile[]) => void,
            depth: number,
        ) => void,
        id: string,
        defaultFormat: string,
        describe: (file: BrowserFile) => unknown,
        select: (file: BrowserFile, div: HTMLElement | null) => void,
        extraHeader?: string,
        defaultDepth?: number,
    );
    update(isRefresh?: boolean, callback?: (() => void) | null): void;
    refresh(): void;
    lightRefresh(): void;
    allowMultiSelect: boolean;
    showDepth: boolean;
    showUpFolder: boolean;
    showFilter: boolean;
    showRefresh: boolean;
    showDisplayFormat: boolean;
    contentDiv: HTMLElement;
    everLoaded: boolean;
    lastFiles: BrowserFile[];
    lastListCache: {
        folder: string;
        folders: string[];
        files: BrowserFile[];
    } | null;
    headerCount?: HTMLElement;
    buildContentList(
        container: HTMLElement,
        files: BrowserFile[],
        before?: HTMLElement | null,
        startId?: number,
    ): void;
}

declare function describeOutputFile(file: BrowserFile): unknown;
declare function selectOutputInHistory(
    file: BrowserFile,
    div: HTMLElement | null,
): void;
