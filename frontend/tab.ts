// The "Quarry" bottom-bar tab. It hosts the Quarry datasets panel (settings.ts) — the same UI that used to
// live under Tools → Quarry. This module only owns the tab scaffolding (the nav entry + pane + wiring it into
// SwarmUI's MovableGenTab layout); the panel content is rendered into `#quarry-tab-body` by settings.ts.

const TAB_ID = "Quarry-Tab";
// The element settings.ts fills with the Quarry datasets panel.
export const QUARRY_TAB_BODY_ID = "quarry-tab-body";

/// Wires a MovableGenTab for our nav link so it gets SwarmUI's custom (non-bootstrap) tab behavior. Normally
/// runs before genTabLayout.init(), which then finalizes the tab; the post-init branch covers late injection.
const registerTabWithLayout = (navLink: HTMLElement): void => {
    if (typeof genTabLayout === "undefined" || !genTabLayout) {
        return;
    }
    const tab = new MovableGenTab(navLink, genTabLayout);
    genTabLayout.managedTabs.push(tab);
    if (genTabLayout.managedTabContainers.length > 0) {
        tab.contentElem.style.height = "100%";
        tab.contentElem.style.width = "100%";
        if (
            !genTabLayout.managedTabContainers.includes(
                tab.contentElem.parentElement,
            )
        ) {
            genTabLayout.managedTabContainers.push(
                tab.contentElem.parentElement,
            );
        }
        tab.update();
        tab.navElem.addEventListener("click", () =>
            browserUtil.makeVisible(tab.contentElem),
        );
        genTabLayout.reapplyPositions();
    }
};

/// Injects the Quarry tab into the bottom bar with an empty body for the panel. Must run before
/// genTabLayout.init() (which scans the tab list) — main.ts calls this synchronously at script load, ahead of
/// that. Idempotent: a second call is a no-op once the tab exists.
export const injectQuarryTab = (): void => {
    const nav = document.getElementById("bottombartabcollection");
    const content = document.getElementById("t2i_bottom_bar_content");
    if (!nav || !content || document.getElementById(TAB_ID)) {
        return;
    }
    const li = document.createElement("li");
    li.className = "nav-item";
    li.setAttribute("role", "presentation");
    li.innerHTML = `<a class="nav-link translate" data-bs-toggle="tab" href="#${TAB_ID}" aria-selected="false" tabindex="-1" role="tab">Quarry</a>`;
    // Sit next to Wildcards, just before the Tools tab.
    const toolsNav = nav.querySelector('a[href="#Tools-Tab"]');
    if (toolsNav?.parentElement) {
        nav.insertBefore(li, toolsNav.parentElement);
    } else {
        nav.appendChild(li);
    }
    const pane = document.createElement("div");
    pane.className = "tab-pane genpage-bottom-tab";
    pane.id = TAB_ID;
    pane.setAttribute("role", "tabpanel");
    pane.innerHTML = `<div class="quarry-tab-body" id="${QUARRY_TAB_BODY_ID}"></div>`;
    content.appendChild(pane);
    const navLink = li.querySelector("a");
    if (navLink) {
        registerTabWithLayout(navLink);
    }
};
