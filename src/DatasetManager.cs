using System.IO;
using FreneticUtilities.FreneticExtensions;
using SwarmUI.Core;
using SwarmUI.Utils;

namespace Quarry;

// A dataset served as a <q:NAME> reference: its WildcardName, the absolute Path, and a cheap change FileHash.
public sealed record DatasetEntry(string WildcardName, string Path, string FileHash);

// Orchestrates the datasets folder: scans it, tracks a name -> dataset map, owns the shared DuckDB backend,
// and delegates derived state to DatasetCache / ColumnConfig / DatasetWarmer. Quarry serves its own <q:> tag
// and writes nothing to SwarmUI's Wildcards folder.
public static class DatasetManager
{
    public static string DatasetsFolder { get; set; } = "";

    // This extension's own folder (SwarmUI's Extension.FilePath), set during OnInit. Empty until then.
    public static string ExtensionFolder { get; set; } = "";

    public static string CacheFolder => DatasetCache.CacheFolder;

    // Active whenever a datasets folder is set (one is created by default on init) — no separate enable toggle.
    public static bool IsActive => !string.IsNullOrWhiteSpace(DatasetsFolder);

    // key = wildcard name lowercased
    private static readonly ConcurrentDictionary<string, DatasetEntry> Datasets = new();

    // Number of preview rows the UI requests and that warming pre-caches; kept in sync so a warmed preview is a
    // cache hit for the real request.
    public const int DefaultPreviewLimit = 100;

    private static DuckDbQueryBackend _backend;

    public static DuckDbQueryBackend Backend => _backend ??= new DuckDbQueryBackend();

    // Whether the DuckDB lance extension is installed and loadable. Best-effort: any probe failure reports
    // false (the UI then offers to install). Cheap — an in-engine catalog lookup, no download and no scan.
    public static bool RequirementsInstalled
    {
        get
        {
            try
            {
                return Backend.IsLanceInstalled();
            }
            catch
            {
                return false;
            }
        }
    }

    // Downloads a ~235 MB signed binary on first run; blocking and slow, so call it off the request thread.
    public static void InstallRequirements() => Backend.InstallLance();

    public static int Count => Datasets.Count;

    public static void Initialize()
    {
        DatasetCache.Load();
        if (IsActive)
        {
            Sync();
        }
        Program.ModelRefreshEvent += OnModelRefresh;
    }

    public static void Shutdown()
    {
        Program.ModelRefreshEvent -= OnModelRefresh;
        DatasetCache.PersistIfDirty();
        _backend?.Dispose();
        _backend = null;
    }

    private static void OnModelRefresh()
    {
        if (IsActive)
        {
            Sync();
        }
    }

    public static DatasetEntry Resolve(string wildcardName)
    {
        if (!IsActive || wildcardName is null)
        {
            return null;
        }
        return Datasets.TryGetValue(wildcardName.ToLowerFast(), out DatasetEntry entry) ? entry : null;
    }

    public static string GetConfiguredPromptColumn(string wildcardName) => ColumnConfig.GetPromptColumn(wildcardName);

    public static void SetPromptColumns(IReadOnlyDictionary<string, string> columns) => ColumnConfig.SetPromptColumns(columns);

    public static IReadOnlyDictionary<string, string> GetPromptColumnsSnapshot() => ColumnConfig.GetPromptColumnsSnapshot();

    public static IReadOnlyList<string> GetConfiguredTagColumns(string wildcardName) => ColumnConfig.GetTagColumns(wildcardName);

    public static void SetTagColumns(IReadOnlyDictionary<string, IReadOnlyList<string>> columns) => ColumnConfig.SetTagColumns(columns);

    public static IReadOnlyDictionary<string, IReadOnlyList<string>> GetTagColumnsSnapshot() => ColumnConfig.GetTagColumnsSnapshot();

    public static IReadOnlyCollection<DatasetEntry> AllDatasets => [.. Datasets.Values];

    public static IReadOnlyList<string> AllDatasetNames => [.. Datasets.Values.Select(e => e.WildcardName)];

    public static ColumnSchema GetSchema(DatasetEntry entry)
    {
        string key = entry.WildcardName.ToLowerFast();
        if (DatasetCache.TryGetSchema(key, entry.FileHash, out ColumnSchema cached))
        {
            return cached;
        }
        ColumnSchema schema = Backend.GetSchema(entry.Path);
        DatasetCache.StoreSchema(key, entry.FileHash, schema);
        return schema;
    }

    // The dataset's total row count, which (blank-prompt rows are excluded at ingest) is also the usable-pick
    // count. For Lance this is a metadata read, no scan. Keyed by the resolved prompt column so a config change
    // never serves a count stored under a different column.
    public static long GetRowCount(DatasetEntry entry, string promptColumn)
    {
        string key = entry.WildcardName.ToLowerFast();
        string column = promptColumn ?? "";
        if (DatasetCache.TryGetRowCount(key, entry.FileHash, column, out long cached))
        {
            return cached;
        }
        long count = Backend.CountRows(entry.Path, SqlFilter.None);
        DatasetCache.StoreRowCount(key, entry.FileHash, column, count);
        return count;
    }

    public static bool TryGetFilteredCount(DatasetEntry entry, SqlFilter filter, out long count)
        => DatasetCache.TryGetFilteredCount(DatasetCache.FilteredCountKey(entry, filter), out count);

    // Rows matching `filter`, cached for the file's current hash. On a miss it scans once on the shared
    // connection. For a fan-out over many datasets, call WarmFilteredCounts first to populate in parallel.
    public static long CountRowsFiltered(DatasetEntry entry, SqlFilter filter)
    {
        string key = DatasetCache.FilteredCountKey(entry, filter);
        if (DatasetCache.TryGetFilteredCount(key, out long cached))
        {
            return cached;
        }
        long count = Backend.CountRows(entry.Path, filter);
        DatasetCache.StoreFilteredCount(key, count);
        DatasetCache.PersistIfDirty();
        return count;
    }

    public static void WarmFilteredCounts(IReadOnlyList<(DatasetEntry Entry, SqlFilter Filter)> requests)
        => DatasetWarmer.WarmFilteredCounts(Backend, requests);

    public static bool TryGetCachedRowCount(DatasetEntry entry, string promptColumn, out long count)
        => DatasetCache.TryGetRowCount(entry.WildcardName.ToLowerFast(), entry.FileHash, promptColumn ?? "", out count);

    // Per-dataset info for the settings UI. The schema is always read (cheap, bounded sample). A cached row
    // count is surfaced when one exists (e.g. warmed in a prior session) so counts show on first load without a
    // Refresh; only when `includeRowCounts` (the Refresh path, after a warm) is an uncached count computed —
    // eagerly counting every dataset here once made initial load hang.
    public static List<DatasetInfo> GetDatasetsInfo(bool includeRowCounts = false)
    {
        List<DatasetInfo> result = [];
        foreach (DatasetEntry entry in Datasets.Values.OrderBy(e => e.WildcardName, StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                ColumnSchema schema = GetSchema(entry);
                string resolved = PromptColumnResolver.Resolve(GetConfiguredPromptColumn(entry.WildcardName), schema);
                long? rowCount = TryGetCachedRowCount(entry, resolved, out long cachedCount) ? cachedCount : null;
                if (rowCount is null && includeRowCounts)
                {
                    try
                    {
                        rowCount = GetRowCount(entry, resolved);
                    }
                    catch
                    {
                        // Row count is a best-effort display value; a failure must not hide a readable dataset.
                    }
                }
                result.Add(new DatasetInfo(entry.WildcardName, [.. schema.Columns], resolved, GetConfiguredPromptColumn(entry.WildcardName), [.. GetConfiguredTagColumns(entry.WildcardName)], rowCount, null));
            }
            catch (Exception ex)
            {
                result.Add(new DatasetInfo(entry.WildcardName, [], null, GetConfiguredPromptColumn(entry.WildcardName), [.. GetConfiguredTagColumns(entry.WildcardName)], null, ex.Message));
            }
        }
        // Reading schemas above may have populated cache entries — flush them once for the whole batch.
        DatasetCache.PersistIfDirty();
        return result;
    }

    // The on-demand counterpart to the deliberately count-free GetDatasetsInfo: the preview path calls it so
    // each file is counted only when the user actually asks for it.
    public static (bool Success, long? RowCount, string Error) GetUsableRowCount(string wildcardName)
    {
        DatasetEntry entry = Resolve(wildcardName);
        if (entry is null)
        {
            return (false, null, $"Unknown dataset '{wildcardName}'.");
        }
        try
        {
            ColumnSchema schema = GetSchema(entry);
            string resolved = PromptColumnResolver.Resolve(GetConfiguredPromptColumn(entry.WildcardName), schema);
            long count = GetRowCount(entry, resolved);
            DatasetCache.PersistIfDirty();
            return (true, count, null);
        }
        catch (Exception ex)
        {
            return (false, null, ex.Message);
        }
    }

    public static (bool Success, List<string> Columns, List<List<string>> Rows, string Error) PreviewDataset(string wildcardName, int limit)
    {
        DatasetEntry entry = Resolve(wildcardName);
        if (entry is null)
        {
            return (false, null, null, $"Unknown dataset '{wildcardName}'.");
        }
        string key = entry.WildcardName.ToLowerFast();
        if (DatasetCache.TryGetPreview(key, entry.FileHash, limit, out DatasetCache.PreviewData cached))
        {
            return (true, cached.Columns, cached.Rows, null);
        }
        try
        {
            (List<string> columns, List<List<string>> rows) = Backend.GetSampleRows(entry.Path, limit);
            DatasetCache.StorePreview(key, entry.FileHash, new DatasetCache.PreviewData(limit, columns, rows));
            DatasetCache.PersistIfDirty();
            return (true, columns, rows, null);
        }
        catch (Exception ex)
        {
            return (false, null, null, ex.Message);
        }
    }

    public static int WarmAll()
        => IsActive ? DatasetWarmer.WarmAll(Backend, [.. Datasets.Values], DefaultPreviewLimit) : 0;

    // Scans the datasets folder and rebuilds the name -> dataset map. Drops datasets no longer present,
    // invalidates changed entries, and resets the DuckDB connection when anything changed.
    public static void Sync()
    {
        if (!IsActive)
        {
            // Keep the file-backed cache intact (hash-keyed, only discarded when a file changes), so re-enabling
            // Quarry doesn't recompute counts/previews. Just stop serving.
            Datasets.Clear();
            return;
        }
        try
        {
            string root = DatasetsFolder;
            if (!Directory.Exists(root))
            {
                Logs.Warning($"Quarry: datasets folder does not exist: '{root}'");
                return;
            }
            HashSet<string> seen = [];
            // Whether any dataset was added, removed, or had its file change. If so we reset the DuckDB
            // connection below: a regenerated Lance dataset keeps its path but gets new fragment files, and the
            // old connection's cached manifest would still point at the deleted ones.
            bool contentChanged = false;
            foreach (string datasetPath in DatasetScanner.Enumerate(root))
            {
                string relative = Path.GetRelativePath(root, datasetPath);
                string name = WildcardNaming.ToWildcardName(relative);
                string key = name.ToLowerFast();
                if (!seen.Add(key))
                {
                    Logs.Warning($"Quarry: multiple files map to '{name}'; keeping the first, ignoring '{relative}'.");
                    continue;
                }
                string hash = ComputeHash(datasetPath);
                DatasetCache.InvalidateIfChanged(key, hash);
                if (!Datasets.TryGetValue(key, out DatasetEntry previous) || previous.FileHash != hash)
                {
                    contentChanged = true;
                }
                Datasets[key] = new DatasetEntry(name, datasetPath, hash);
            }
            foreach (string key in Datasets.Keys.Where(k => !seen.Contains(k)).ToList())
            {
                Datasets.TryRemove(key, out _);
                DatasetCache.Remove(key);
                contentChanged = true;
            }
            if (contentChanged)
            {
                _backend?.Reset();
            }
            DatasetCache.Prune(Datasets);
            DatasetCache.PersistIfDirty();
            Logs.Info($"Quarry: synced {Datasets.Count} dataset(s).");
        }
        catch (Exception ex)
        {
            Logs.Error($"Quarry: error syncing datasets: {ex.ReadableString()}");
        }
    }

    public static (bool Success, int Count, string Message, string Error) Refresh()
    {
        if (!IsActive)
        {
            return (false, 0, null, "Quarry is not active. Enable it and set a folder first.");
        }
        try
        {
            Sync();
            return (true, Count, $"Synced {Count} dataset(s).", null);
        }
        catch (Exception ex)
        {
            return (false, 0, null, ex.Message);
        }
    }

    private static string ComputeHash(string path)
    {
        try
        {
            if (Directory.Exists(path)) // Lance dataset directory
            {
                return $"dir:{new DirectoryInfo(path).LastWriteTimeUtc.Ticks}";
            }
            FileInfo info = new(path);
            return $"{info.Length}:{info.LastWriteTimeUtc.Ticks}";
        }
        catch
        {
            return "unknown";
        }
    }
}

// Settings-UI view of one dataset: its columns, the resolved prompt column (what would be used now), the
// explicitly configured column (if any), the row count (null when unknown), and an error if the schema
// couldn't be read.
public sealed record DatasetInfo(
    string Name,
    IReadOnlyList<ColumnInfo> Columns,
    string ResolvedPromptColumn,
    string ConfiguredPromptColumn,
    IReadOnlyList<string> ConfiguredTagColumns,
    long? RowCount,
    string Error);
