const TAB_ID = "ImageSearch-Tab";
export const IMAGE_SEARCH_BODY_ID = "imagesearch-tab-body";

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

export const injectImageSearchTab = (onFirstShow: () => void): void => {
    const nav = document.getElementById("bottombartabcollection");
    const content = document.getElementById("t2i_bottom_bar_content");
    if (!nav || !content || document.getElementById(TAB_ID)) {
        return;
    }
    const li = document.createElement("li");
    li.className = "nav-item";
    li.setAttribute("role", "presentation");
    li.innerHTML = `<a class="nav-link translate" data-bs-toggle="tab" href="#${TAB_ID}" id="imagesearchtabbutton" aria-selected="false" tabindex="-1" role="tab">Image Search</a>`;
    const historyNav = nav.querySelector("#imagehistorytabclickable");
    if (historyNav?.parentElement) {
        historyNav.parentElement.insertAdjacentElement("afterend", li);
    } else {
        nav.appendChild(li);
    }
    const pane = document.createElement("div");
    pane.className = "tab-pane genpage-bottom-tab";
    pane.id = TAB_ID;
    pane.setAttribute("role", "tabpanel");
    pane.innerHTML = `<div class="imagesearch-body" id="${IMAGE_SEARCH_BODY_ID}"></div>`;
    content.appendChild(pane);

    const navLink = li.querySelector("a");
    if (navLink) {
        registerTabWithLayout(navLink);
        let initialized = false;
        navLink.addEventListener("click", () => {
            if (!initialized) {
                initialized = true;
                onFirstShow();
            }
        });
    }
};
