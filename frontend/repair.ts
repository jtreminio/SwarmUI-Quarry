import type { RepairDatasetsResponse } from "./types";

export const bindRepairButton = (
    onChanged: () => void,
    onBusy?: (busy: boolean) => void,
): void => {
    const button = document.getElementById(
        "quarry-repair-datasets",
    ) as HTMLButtonElement | null;
    const status = document.getElementById("quarry-repair-status");
    button?.addEventListener("click", () => {
        if (button.disabled || !status) {
            return;
        }
        button.disabled = true;
        onBusy?.(true);
        button.textContent = "Repairing…";
        status.textContent =
            "Checking local datasets. No dataset downloads are needed.";
        status.className = "quarry-repair-status";
        const finish = (): void => {
            button.disabled = false;
            button.textContent = "Repair datasets";
            onBusy?.(false);
        };
        const fail = (error: unknown): void => {
            finish();
            status.className = "quarry-repair-status quarry-message-error";
            status.textContent = `Repair failed: ${String(error)}. Refresh the dataset list before retrying.`;
        };
        genericRequest<RepairDatasetsResponse>(
            "QuarryRepairDatasets",
            {},
            (data) => {
                if (!data.success) {
                    fail(data.error ?? "unknown error");
                    return;
                }
                finish();
                const repaired = data.repaired ?? 0;
                const checked = data.checked ?? 0;
                const issues = data.issues ?? [];
                const summary =
                    repaired > 0
                        ? `Repaired ${repaired.toLocaleString()} of ${checked.toLocaleString()} checked datasets without downloading data. Previous metadata was backed up locally.`
                        : `Checked ${checked.toLocaleString()} datasets. No stale-version repairs were made.`;
                status.textContent = [
                    summary,
                    ...issues.map(
                        (issue) => `${issue.dataset}: ${issue.error}`,
                    ),
                ].join("\n");
                status.className = `quarry-repair-status ${issues.length > 0 ? "quarry-message-error" : "quarry-message-success"}`;
                onChanged();
            },
            0,
            fail,
        );
    });
};
