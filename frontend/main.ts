import { registerQuarryCompletion } from "./complete";
import { startPromptWatcher } from "./prompt";
import { quarry } from "./settings";
import { injectQuarryTab } from "./tab";

// Inject the bottom-bar Quarry tab now, synchronously: genTabLayout.init() (scheduled by finalscript.js, which
// loads right after this script) scans the tab list once, so the tab must already be in the DOM by then. The
// panel content is rendered into it by quarry.init() at boot.
injectQuarryTab();

const boot = (): void => {
    quarry.init();
    startPromptWatcher();
    // Wire `<q:...>` suggestions into SwarmUI's prompt autocompleter; the dataset list it draws from is kept
    // current by settings.ts as datasets load/refresh.
    registerQuarryCompletion();
};

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
} else {
    boot();
}
