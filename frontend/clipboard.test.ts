import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { copyToClipboard } from "./clipboard";

const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const command = Object.getOwnPropertyDescriptor(document, "execCommand");
afterEach(() => {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
    if (command) Object.defineProperty(document, "execCommand", command);
    else Reflect.deleteProperty(document, "execCommand");
});

describe("Modal clipboard", () => {
    it("waits for the clipboard write before reporting success", async () => {
        let finish: (() => void) | undefined;
        const write = jest
            .fn<(text: string) => Promise<void>>()
            .mockImplementation(
                () =>
                    new Promise<void>((resolve) => {
                        finish = resolve;
                    }),
            );
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: write },
        });
        let complete = false;
        const result = copyToClipboard("<q:nl/example>", document.body).then(
            (success) => {
                complete = true;
                return success;
            },
        );
        await Promise.resolve();
        expect(complete).toBe(false);
        expect(write).toHaveBeenCalledWith("<q:nl/example>");
        finish?.();
        expect(await result).toBe(true);
    });

    it.each([
        false,
        true,
    ])("keeps fallback inside the focused modal after clipboard rejection: %s", async (reject) => {
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: reject
                ? {
                      writeText: jest
                          .fn<() => Promise<void>>()
                          .mockRejectedValue(new Error("Denied")),
                  }
                : undefined,
        });
        const modal = document.createElement("div");
        const button = document.createElement("button");
        modal.append(button);
        document.body.append(modal);
        button.focus();
        Object.defineProperty(document, "execCommand", {
            configurable: true,
            value: jest.fn((operation: string) => {
                const selected = document.activeElement as HTMLTextAreaElement;
                expect(operation).toBe("copy");
                expect(modal.contains(selected)).toBe(true);
                expect(
                    selected.value.slice(
                        selected.selectionStart,
                        selected.selectionEnd,
                    ),
                ).toBe("<q:nl/example>");
                return true;
            }),
        });
        expect(await copyToClipboard("<q:nl/example>", modal)).toBe(true);
        expect(modal.querySelector("textarea")).toBeNull();
        expect(document.activeElement).toBe(button);
    });

    it("reports failure when the fallback cannot copy", async () => {
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: undefined,
        });
        Object.defineProperty(document, "execCommand", {
            configurable: true,
            value: () => false,
        });
        expect(await copyToClipboard("text", document.body)).toBe(false);
        expect(document.querySelector("textarea")).toBeNull();
    });
});
