import { afterEach, describe, expect, it } from "@jest/globals";
import { quarry } from "./settings";
import type { SettingsResponse } from "./types";

const originalRequest = globalThis.genericRequest;

afterEach(() => {
    globalThis.genericRequest = originalRequest;
    document.body.innerHTML = "";
});

describe("image search settings permissions", () => {
    it.each([
        false,
        true,
    ])("keeps dataset settings usable with history permission %s", (canViewImageHistory) => {
        const saves: Record<string, unknown>[] = [];
        const response: SettingsResponse = {
            success: true,
            requirementsInstalled: true,
            canViewImageHistory,
            datasetsFolder: "Data/Quarry",
            datasets: [],
            ...(canViewImageHistory
                ? {
                      imageSearchDirectories: [
                          "Starred",
                          "deleted",
                          "restricted",
                      ],
                      imageSearchDirectoryOptions: ["Starred", "raw"],
                  }
                : {}),
        };
        globalThis.genericRequest = <T>(
            name: string,
            data: object,
            callback: (result: T) => void,
        ): void => {
            if (name === "QuarryGetSettings") {
                callback(response as T);
            } else if (name === "QuarrySaveSettings") {
                saves.push(data as Record<string, unknown>);
            }
        };
        document.body.innerHTML = '<div id="quarry-tab-body"></div>';
        quarry.init();
        const setting = document.querySelector(
            ".quarry-search-folder-setting",
        ) as HTMLElement;
        expect(setting.hidden).toBe(!canViewImageHistory);
        expect(
            setting.querySelectorAll("[data-quarry-search-folder-check]")
                .length,
        ).toBe(canViewImageHistory ? 3 : 0);
        document
            .getElementById("quarry-form")
            ?.dispatchEvent(
                new Event("submit", { bubbles: true, cancelable: true }),
            );
        expect(saves).toHaveLength(1);
        expect(saves[0].datasetsFolder).toBe("Data/Quarry");
        if (canViewImageHistory) {
            expect(saves[0].imageSearchDirectoriesJson).toBe('["Starred"]');
        } else {
            expect(saves[0]).not.toHaveProperty("imageSearchDirectoriesJson");
        }
    });
});
