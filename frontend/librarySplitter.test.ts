import { afterEach, expect, it } from "@jest/globals";
import { bindLibrarySplitter } from "./librarySplitter";

afterEach(() => localStorage.removeItem("barspot_browser_quarry"));

it("clamps keyboard resizing, remembers width, and removes listeners", () => {
    const root = document.createElement("div");
    root.innerHTML =
        '<nav class="quarry-explore-rail"></nav><div class="quarry-library-splitter"></div>';
    document.body.append(root);
    Object.defineProperty(root, "clientWidth", { value: 1000 });
    const handle = root.querySelector<HTMLElement>(".quarry-library-splitter");
    if (!handle) throw new Error("Missing splitter");
    const cleanup = bindLibrarySplitter(root);
    const press = (key: string) =>
        handle.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true }),
        );
    press("End");
    expect(root.style.getPropertyValue("--quarry-rail-width")).toBe("500px");
    press("ArrowRight");
    expect(handle.getAttribute("aria-valuenow")).toBe("500");
    press("Home");
    press("ArrowRight");
    expect(localStorage.getItem("barspot_browser_quarry")).toBe("208");
    cleanup();
    press("End");
    expect(handle.getAttribute("aria-valuenow")).toBe("208");
    const restored = bindLibrarySplitter(root);
    expect(root.style.getPropertyValue("--quarry-rail-width")).toBe("208px");
    restored();
});
