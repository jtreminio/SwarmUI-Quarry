import { registerQuarryCompletion } from "./complete";
import { startPromptWatcher } from "./prompt";
import { initImageSearch } from "./search";
import { injectImageSearchTab } from "./searchtab";
import { quarry } from "./settings";
import { injectQuarryTab } from "./tab";

injectQuarryTab();
injectImageSearchTab(initImageSearch);

const boot = (): void => {
    quarry.init();
    startPromptWatcher();
    registerQuarryCompletion();
};

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
} else {
    boot();
}
