// Shared DTOs mirroring the JObject shapes returned by the Quarry API endpoints (QuarryExtension.cs).

export type ColumnKind = "scalar" | "list";

export interface ColumnDto {
    name: string;
    kind: ColumnKind;
}

export interface DatasetDto {
    name: string;
    columns: ColumnDto[];
    resolvedPromptColumn: string | null;
    configuredPromptColumn: string | null;
    configuredTagColumns: string[];
    rowCount: number | null;
    error: string | null;
}

export interface SettingsResponse {
    success: boolean;
    enabled?: boolean;
    datasetsFolder?: string;
    active?: boolean;
    // False when Quarry's runtime requirement (the DuckDB lance extension) isn't installed yet; the UI then
    // shows only the install gate. Omitted/true once it's available.
    requirementsInstalled?: boolean;
    count?: number;
    datasets?: DatasetDto[];
    message?: string;
    error?: string;
}

// Result of the QuarryInstallRequirements endpoint (installs the DuckDB lance extension).
export interface InstallResponse {
    success: boolean;
    error?: string;
}

export interface PreviewResponse {
    success: boolean;
    dataset?: string;
    columns?: string[];
    rows?: string[][];
    // Row count, loaded lazily alongside the preview rows (null when it couldn't be counted).
    rowCount?: number | null;
    error?: string;
}

export interface ReferencesResponse {
    success: boolean;
    names?: string[];
}
