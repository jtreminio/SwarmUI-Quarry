import { afterEach, expect, it, jest } from "@jest/globals";
import { injectQuarryTab, QUARRY_TAB_BODY_ID } from "./tab";

afterEach(() => {
    document.body.replaceChildren();
    jest.restoreAllMocks();
});

it("caps Quarry at the viewport when SwarmUI's parent panel extends below it", () => {
    document.body.innerHTML =
        '<ul id="bottombartabcollection"></ul><div id="t2i_bottom_bar_content"></div>';
    injectQuarryTab();
    const pane = document.getElementById("Quarry-Tab") as HTMLElement;
    const body = document.getElementById(QUARRY_TAB_BODY_ID) as HTMLElement;
    jest.spyOn(pane, "getClientRects").mockReturnValue(
        Object.assign([new DOMRect()], { item: () => new DOMRect() }),
    );
    let top = window.innerHeight - 250;
    jest.spyOn(pane, "getBoundingClientRect").mockImplementation(
        () => ({ top }) as DOMRect,
    );
    window.dispatchEvent(new Event("resize"));
    expect(body.style.maxHeight).toBe("250px");
    top -= 100;
    window.dispatchEvent(new Event("resize"));
    expect(body.style.maxHeight).toBe("350px");
    top = window.innerHeight + 10;
    window.dispatchEvent(new Event("resize"));
    expect(body.style.maxHeight).toBe("0px");
});
