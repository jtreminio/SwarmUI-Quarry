// Small shared helpers used by both the settings panel and the dataset-download modal. Kept in their own
// module so the two feature modules can share them without importing each other (avoiding an import cycle).

/// Escapes a string for safe interpolation into HTML (via the browser's own text-to-markup conversion).
export const escapeHtml = (text: string): string => {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
};

/// Formats a byte count as a short human-readable size (e.g. `3.4 GB`, `340 MB`, `153 B`). Decimal units
/// (1000-based), to match how download sizes are conventionally shown. Null/negative renders as an em-dash.
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
