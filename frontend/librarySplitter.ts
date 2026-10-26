const STORAGE_KEY = "barspot_browser_quarry";

export const bindLibrarySplitter = (root: HTMLElement): (() => void) => {
    const handle = root.querySelector<HTMLElement>(".quarry-library-splitter");
    if (!handle) return () => {};
    let width = 0;
    let pointer: number | null = null;
    try {
        width = Number(localStorage.getItem(STORAGE_KEY)) || 0;
    } catch {}
    const bounds = () => ({
        min: 192,
        max: Math.max(192, root.clientWidth / 2),
    });
    const apply = () => {
        const { min, max } = bounds();
        if (width)
            root.style.setProperty(
                "--quarry-rail-width",
                `${Math.min(max, Math.max(min, width))}px`,
            );
        handle.setAttribute("aria-valuemin", String(min));
        handle.setAttribute("aria-valuemax", String(Math.round(max)));
        handle.setAttribute(
            "aria-valuenow",
            String(
                Math.round(
                    width
                        ? Math.min(max, Math.max(min, width))
                        : (root
                              .querySelector<HTMLElement>(
                                  ".quarry-explore-rail",
                              )
                              ?.getBoundingClientRect().width ?? min),
                ),
            ),
        );
    };
    const resize = (next: number) => {
        const { min, max } = bounds();
        width = Math.min(max, Math.max(min, next));
        apply();
        try {
            localStorage.setItem(STORAGE_KEY, String(width));
        } catch {}
    };
    const down = (event: PointerEvent) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        pointer = event.pointerId;
        handle.setPointerCapture?.(event.pointerId);
    };
    const move = (event: PointerEvent) => {
        if (pointer === event.pointerId)
            resize(event.clientX - root.getBoundingClientRect().left);
    };
    const up = (event: PointerEvent) => {
        if (pointer !== event.pointerId) return;
        pointer = null;
        if (handle.hasPointerCapture?.(event.pointerId))
            handle.releasePointerCapture(event.pointerId);
    };
    const key = (event: KeyboardEvent) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
        event.preventDefault();
        const { min, max } = bounds();
        const current = Number(handle.getAttribute("aria-valuenow"));
        resize(
            event.key === "Home"
                ? min
                : event.key === "End"
                  ? max
                  : current + (event.key === "ArrowLeft" ? -16 : 16),
        );
    };
    handle.addEventListener("pointerdown", down);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
    handle.addEventListener("lostpointercapture", up);
    handle.addEventListener("keydown", key);
    const observer =
        typeof ResizeObserver === "undefined"
            ? null
            : new ResizeObserver(apply);
    observer?.observe(root);
    apply();
    return () => {
        observer?.disconnect();
        handle.removeEventListener("pointerdown", down);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        handle.removeEventListener("lostpointercapture", up);
        handle.removeEventListener("keydown", key);
    };
};
