/** Locate outer query sections without confusing record selectors or quoted options. */
export const querySections = (text: string) => {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let filterOpen = -1;
    let filterClose = -1;
    let colon = -1;
    let pipe = -1;
    let optionStart = -1;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (c === "\\") escaped = true;
            else if (c === '"') quoted = false;
            continue;
        }
        if (c === '"' && pipe >= 0) {
            quoted = true;
            continue;
        }
        if (c === "[") {
            if (depth === 0 && colon < 0 && pipe < 0 && filterOpen < 0)
                filterOpen = i;
            depth++;
        } else if (c === "]") {
            depth--;
            if (depth === 0 && colon < 0 && pipe < 0) filterClose = i;
        } else if (depth === 0) {
            if (c === ":" && colon < 0 && pipe < 0) colon = i;
            if (c === "|" && pipe < 0) {
                pipe = i;
                optionStart = i + 1;
            }
            if (c === ";" && pipe >= 0) optionStart = i + 1;
        }
    }
    return { filterOpen, filterClose, colon, pipe, optionStart, quoted };
};
