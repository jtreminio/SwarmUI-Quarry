export type ColumnKind = "scalar" | "list";

export interface ColumnDto {
    name: string;
    kind: ColumnKind;
    numeric?: boolean;
}

export interface DatasetDto {
    name: string;
    columns: ColumnDto[];
    resolvedPromptColumn: string | null;
    configuredPromptColumn: string | null;
    configuredTagColumns: string[];
    rowCount: number | null;
    enabled?: boolean;
    error: string | null;
}

export interface SettingsResponse {
    success: boolean;
    datasetsFolder?: string;
    addToExistingTag?: boolean;
    active?: boolean;
    requirementsInstalled?: boolean;
    count?: number;
    datasets?: DatasetDto[];
    message?: string;
    error?: string;
}

export interface InstallResponse {
    success: boolean;
    error?: string;
}

export interface CleanTempResponse {
    success: boolean;
    removed?: number;
    error?: string;
}

export interface PreviewResponse {
    success: boolean;
    dataset?: string;
    columns?: string[];
    rows?: string[][];
    rowCount?: number | null;
    error?: string;
}

export interface ReferencesResponse {
    success: boolean;
    names?: string[];
}

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
    tokenSet?: boolean;
    datasets?: RemoteDatasetDto[];
    error?: string;
}

export interface StartDownloadResponse {
    success: boolean;
    id?: number;
    error?: string;
}

export interface DownloadStatusResponse {
    success: boolean;
    active?: boolean;
    id?: number;
    dataset?: string;
    state?: string;
    bytesDone?: number;
    bytesTotal?: number;
    filesDone?: number;
    filesTotal?: number;
    perSecond?: number;
    error?: string;
}

export type ImageFieldType = "text" | "number" | "list" | "bool";

export interface ImageFieldDto {
    name: string;
    label: string;
    type: ImageFieldType;
}

export interface OperatorDto {
    value: string;
    label: string;
}

export interface ImageFieldsResponse {
    success: boolean;
    available?: boolean;
    hasIndex?: boolean;
    coreFields?: ImageFieldDto[];
    discoveredFields?: string[];
    operators?: Record<string, OperatorDto[]>;
    error?: string;
}

export interface ImageSearchResponse {
    success: boolean;
    available?: boolean;
    hasIndex?: boolean;
    columns?: string[];
    rows?: string[][];
    total?: number;
    returned?: number;
    offset?: number;
    warnings?: string[];
    error?: string;
}

export interface ScanStartResponse {
    success: boolean;
    id?: number;
    error?: string;
}

export interface ScanStatusResponse {
    success: boolean;
    available?: boolean;
    hasIndex?: boolean;
    active?: boolean;
    id?: number;
    state?: string;
    filesTotal?: number;
    filesDone?: number;
    filesIndexed?: number;
    filesPruned?: number;
    error?: string;
    scanError?: string;
}
