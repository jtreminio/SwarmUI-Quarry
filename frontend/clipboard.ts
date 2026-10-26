/** Keep the fallback inside the active dialog so its focus trap permits selection. */
export const copyToClipboard = async (
    text: string,
    container: HTMLElement,
): Promise<boolean> => {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // Clipboard permissions can fail even when the API is available.
    }
    const active = document.activeElement as HTMLElement | null;
    const input = document.createElement("textarea");
    input.value = text;
    input.readOnly = true;
    input.style.cssText =
        "position:fixed;opacity:0;left:0;top:0;pointer-events:none";
    container.append(input);
    try {
        input.focus({ preventScroll: true });
        input.select();
        return document.execCommand("copy");
    } catch {
        return false;
    } finally {
        input.remove();
        active?.focus({ preventScroll: true });
    }
};
