export const escapeHtml = (text: string): string => {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
};

export const escapeRegExp = (text: string): string =>
    text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const formatBytes = (bytes: number | null | undefined): string => {
    if (bytes == null || bytes < 0) {
        return "—";
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    const decimals = unit === 0 || value >= 100 ? 0 : 1;
    return `${value.toFixed(decimals)} ${units[unit]}`;
};

export const datasetFolder = (name: string): string | null => {
    const slash = name.lastIndexOf("/");
    return slash > 0 ? name.slice(0, slash) : null;
};

export const datasetLeafName = (name: string): string =>
    name.slice(name.lastIndexOf("/") + 1);

export interface FolderNode<T> {
    path: string;
    name: string;
    folders: FolderNode<T>[];
    items: T[];
}

export interface FolderTree<T> {
    loose: T[];
    folders: FolderNode<T>[];
}

export const buildFolderTree = <T extends { name: string }>(
    items: T[],
): FolderTree<T> => {
    const loose: T[] = [];
    const roots: FolderNode<T>[] = [];
    const byPath = new Map<string, FolderNode<T>>();

    const ensureFolder = (path: string): FolderNode<T> => {
        const existing = byPath.get(path);
        if (existing) {
            return existing;
        }
        const slash = path.lastIndexOf("/");
        const node: FolderNode<T> = {
            path,
            name: path.slice(slash + 1),
            folders: [],
            items: [],
        };
        byPath.set(path, node);
        if (slash > 0) {
            ensureFolder(path.slice(0, slash)).folders.push(node);
        } else {
            roots.push(node);
        }
        return node;
    };

    for (const item of items) {
        const folder = datasetFolder(item.name);
        if (folder === null) {
            loose.push(item);
        } else {
            ensureFolder(folder).items.push(item);
        }
    }

    const sortNode = (node: FolderNode<T>): void => {
        node.folders.sort((a, b) => a.name.localeCompare(b.name));
        node.folders.forEach(sortNode);
    };
    roots.sort((a, b) => a.name.localeCompare(b.name));
    roots.forEach(sortNode);

    return { loose, folders: roots };
};

export const folderDatasetCount = <T>(node: FolderNode<T>): number =>
    node.items.length +
    node.folders.reduce((sum, child) => sum + folderDatasetCount(child), 0);

export const folderPrefixes = (path: string): string[] => {
    const prefixes: string[] = [];
    let acc = "";
    for (const part of path.split("/")) {
        acc = acc ? `${acc}/${part}` : part;
        prefixes.push(acc);
    }
    return prefixes;
};

export const allAncestorsExpanded = (
    container: string | null,
    expanded: ReadonlySet<string>,
): boolean =>
    !container || folderPrefixes(container).every((p) => expanded.has(p));

export const refreshFolderVisibility = (
    container: HTMLElement,
    expanded: ReadonlySet<string>,
): void => {
    for (const row of Array.from(
        container.querySelectorAll<HTMLElement>("[data-parent]"),
    )) {
        row.classList.toggle(
            "quarry-row-hidden",
            !allAncestorsExpanded(row.getAttribute("data-parent"), expanded),
        );
    }
};
