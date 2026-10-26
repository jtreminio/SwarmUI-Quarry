import { afterEach, describe, expect, it } from "@jest/globals";
import { mountImageSearchFolders, quarry } from "./settings";
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
            datasets: [
                {
                    name: "kept",
                    columns: [{ name: "prompt", kind: "scalar" }],
                    resolvedPromptColumn: "prompt",
                    configuredPromptColumn: "prompt",
                    configuredTagColumns: ["prompt"],
                    rowCount: 1,
                    error: null,
                    enabled: false,
                },
            ],
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
                callback(response as T);
            }
        };
        document.body.innerHTML = '<div id="quarry-tab-body"></div>';
        quarry.init();
        expect(
            document.querySelector(
                "#quarry-form .quarry-search-folder-setting",
            ),
        ).toBeNull();
        const panel = document.createElement("div");
        document.body.append(panel);
        let allowed = false;
        mountImageSearchFolders(panel, (value) => {
            allowed = value;
        });
        expect(allowed).toBe(canViewImageHistory);
        expect(
            panel.querySelectorAll("[data-quarry-search-folder-check]").length,
        ).toBe(canViewImageHistory ? 3 : 0);
        document
            .getElementById("quarry-form")
            ?.dispatchEvent(
                new Event("submit", { bubbles: true, cancelable: true }),
            );
        expect(saves).toHaveLength(1);
        expect(saves[0].datasetsFolder).toBe("Data/Quarry");
        expect(saves[0]).not.toHaveProperty("imageSearchDirectoriesJson");
        if (canViewImageHistory) {
            (
                document.getElementById("quarry-folder") as HTMLInputElement
            ).value = "unsaved-folder";
            (
                panel.querySelector(
                    "[data-save-search-folders]",
                ) as HTMLButtonElement
            ).click();
            expect(saves[1].imageSearchDirectoriesJson).toBe('["Starred"]');
            expect(saves[1].datasetsFolder).toBe("Data/Quarry");
            expect(saves[1].addToExistingTag).toBe(true);
            expect(saves[1].promptColumnsJson).toBe('{"kept":"prompt"}');
            expect(saves[1].tagColumnsJson).toBe('{"kept":["prompt"]}');
            expect(saves[1].disabledDatasetsJson).toBe('["kept"]');
            expect(
                (document.getElementById("quarry-folder") as HTMLInputElement)
                    .value,
            ).toBe("unsaved-folder");
        } else {
            expect(panel.hidden).toBe(true);
            expect(
                panel.querySelector("[data-save-search-folders]"),
            ).toBeNull();
        }
    });
});
