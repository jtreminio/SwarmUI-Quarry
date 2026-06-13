declare function registerNewTool(id: string, name: string): HTMLElement;

declare function genericRequest<T = unknown>(
    endpoint: string,
    data: Record<string, unknown>,
    callback: (data: T) => void,
): void;

interface QuarryJQuery {
    modal(action: "show" | "hide"): void;
}

declare function $(selector: string | Element): QuarryJQuery;
