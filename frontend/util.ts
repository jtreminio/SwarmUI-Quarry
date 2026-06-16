export const escapeHtml = (text: string): string => {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
};

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
