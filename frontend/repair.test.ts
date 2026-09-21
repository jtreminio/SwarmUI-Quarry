import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
} from "@jest/globals";
import { bindRepairButton } from "./repair";
import type { RepairDatasetsResponse } from "./types";

describe("local dataset repair", () => {
    let respond: (response: RepairDatasetsResponse) => void;
    let reject: ((error: unknown) => void) | null | undefined;
    let calls: string[];
    let changed: ReturnType<typeof jest.fn>;
    const button = () =>
        document.getElementById("quarry-repair-datasets") as HTMLButtonElement;
    const status = () =>
        document.getElementById("quarry-repair-status") as HTMLElement;

    beforeEach(() => {
        document.body.innerHTML =
            '<button id="quarry-repair-datasets">Repair datasets</button><div id="quarry-repair-status"></div>';
        calls = [];
        changed = jest.fn();
        globalThis.genericRequest = <T>(
            endpoint: string,
            _data: Record<string, unknown>,
            callback: (data: T) => void,
            _depth?: number,
            errorHandle?: ((error: unknown) => void) | null,
        ) => {
            calls.push(endpoint);
            respond = (response) => callback(response as T);
            reject = errorHandle;
        };
        bindRepairButton(changed);
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "genericRequest");
        document.body.innerHTML = "";
    });

    it("runs once, shows progress, and refreshes after local repair", () => {
        button().click();
        button().click();
        expect(calls).toEqual(["QuarryRepairDatasets"]);
        expect(button().disabled).toBe(true);
        expect(status().textContent).toContain("No dataset downloads");
        respond({ success: true, checked: 6, repaired: 5, issues: [] });
        expect(button().disabled).toBe(false);
        expect(button().textContent).toBe("Repair datasets");
        expect(status().textContent).toContain("Repaired 5 of 6");
        expect(changed).toHaveBeenCalledTimes(1);
    });

    it("keeps per-dataset failures visible alongside successful repairs as plain text", () => {
        button().click();
        respond({
            success: true,
            checked: 3,
            repaired: 1,
            issues: [
                {
                    dataset: '<img src=x onerror="bad()">',
                    error: "Original metadata restored.",
                },
            ],
        });
        expect(status().textContent).toContain("Repaired 1 of 3");
        expect(status().textContent).toContain("Original metadata restored.");
        expect(status().querySelector("img")).toBeNull();
        expect(status().classList.contains("quarry-message-error")).toBe(true);
        expect(changed).toHaveBeenCalledTimes(1);
    });

    it("reports when no stale-version repair was needed", () => {
        button().click();
        respond({ success: true, checked: 7, repaired: 0 });
        expect(status().textContent).toContain(
            "Checked 7 datasets. No stale-version repairs were made.",
        );
        expect(button().disabled).toBe(false);
    });

    it("reenables the button when another download holds the maintenance lock", () => {
        button().click();
        respond({
            success: false,
            error: "A dataset download or repair is already running.",
        });
        expect(button().disabled).toBe(false);
        expect(status().textContent).toContain("already running");
        expect(changed).not.toHaveBeenCalled();
    });

    it("reenables the button after a request failure", () => {
        button().click();
        reject?.("Connection lost");
        expect(button().disabled).toBe(false);
        expect(status().textContent).toContain("Connection lost");
        expect(changed).not.toHaveBeenCalled();
    });
});
