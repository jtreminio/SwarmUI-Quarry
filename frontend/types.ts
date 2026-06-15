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

// One ready-made dataset on the official HuggingFace collection (QuarryListAvailableDatasets).
export interface RemoteDatasetDto {
    name: string;
    repoPath: string;
    sizeBytes: number;
    fileCount: number;
    installed: boolean;
}

export interface AvailableDatasetsResponse {
    success: boolean;
    repo?: string;
    repoUrl?: string;
    // Whether the user has a HuggingFace token set (downloads work without one — the repo is public).
    tokenSet?: boolean;
    datasets?: RemoteDatasetDto[];
    error?: string;
}

// Result of kicking off a download (QuarryDownloadDataset); `id` identifies the run for status polling.
export interface StartDownloadResponse {
    success: boolean;
    id?: number;
    error?: string;
}

// Live progress of the single in-flight dataset download (QuarryDownloadStatus).
export interface DownloadStatusResponse {
    success: boolean;
    active?: boolean;
    id?: number;
    dataset?: string;
    // idle | starting | downloading | finalizing | done | error | cancelled
    state?: string;
    bytesDone?: number;
    bytesTotal?: number;
    filesDone?: number;
    filesTotal?: number;
    perSecond?: number;
    error?: string;
}
