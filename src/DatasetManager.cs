using System.IO;
using FreneticUtilities.FreneticExtensions;
using SwarmUI.Core;
using SwarmUI.Utils;

namespace Quarry;

public sealed record DatasetEntry(string Name, string Path, string FileHash);

public static class DatasetManager
{
    public static string DatasetsFolder { get; set; } = "";
    public static string ExtensionFolder { get; set; } = "";
    public static string CacheFolder => DatasetCache.CacheFolder;
    public static bool IsActive => !string.IsNullOrWhiteSpace(DatasetsFolder);
    private static readonly ConcurrentDictionary<string, DatasetEntry> Datasets = new();
    public const int DefaultPreviewLimit = 100;
    public const int MaxPreviewLimit = 10000;
    private static DuckDbQueryBackend _backend;
    public static DuckDbQueryBackend Backend => _backend ??= new DuckDbQueryBackend();
    private static readonly SingleFlight<string, ColumnSchema> _schemaFlight = new(StringComparer.Ordinal);
    private static readonly SingleFlight<string, long> _rowCountFlight = new(StringComparer.Ordinal);
    private static readonly SingleFlight<string, long> _filteredCountFlight = new(StringComparer.Ordinal);
    private static readonly SingleFlight<string, DatasetCache.PreviewData> _previewFlight = new(StringComparer.Ordinal);

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

    public static DatasetEntry Resolve(string name)
    {
        if (!IsActive || name is null)
        {
            return null;
        }
        if (Datasets.TryGetValue(name.ToLowerFast(), out DatasetEntry entry))
        {
            return entry;
        }
        string moved = DatasetNameMatching.MatchMissingDirectory(name, AllDatasetNames);
        return moved is not null && Datasets.TryGetValue(moved.ToLowerFast(), out DatasetEntry movedEntry) ? movedEntry : null;
    }

    public static string GetConfiguredPromptColumn(string name) => ColumnConfig.GetPromptColumn(name);

    public static void SetPromptColumns(IReadOnlyDictionary<string, string> columns) => ColumnConfig.SetPromptColumns(columns);

    public static IReadOnlyDictionary<string, string> GetPromptColumnsSnapshot() => ColumnConfig.GetPromptColumnsSnapshot();

    public static IReadOnlyList<string> GetConfiguredTagColumns(string name) => ColumnConfig.GetTagColumns(name);

    public static void SetTagColumns(IReadOnlyDictionary<string, IReadOnlyList<string>> columns) => ColumnConfig.SetTagColumns(columns);

    public static IReadOnlyDictionary<string, IReadOnlyList<string>> GetTagColumnsSnapshot() => ColumnConfig.GetTagColumnsSnapshot();

    public static IReadOnlyCollection<DatasetEntry> AllDatasets => [.. Datasets.Values];

    public static IReadOnlyList<string> AllDatasetNames => [.. Datasets.Values.Select(e => e.Name)];

    public static ColumnSchema GetSchema(DatasetEntry entry)
    {
        string key = entry.Name.ToLowerFast();
        if (DatasetCache.TryGetSchema(key, entry.FileHash, out ColumnSchema cached))
        {
            return cached;
        }
        return _schemaFlight.GetOrBuild(key, () =>
        {
            if (DatasetCache.TryGetSchema(key, entry.FileHash, out ColumnSchema settled))
            {
                return settled;
            }
            ColumnSchema schema = Backend.GetSchema(entry.Path);
            DatasetCache.StoreSchema(key, entry.FileHash, schema);
            return schema;
        });
    }

    public static long GetRowCount(DatasetEntry entry, string promptColumn)
    {
        string key = entry.Name.ToLowerFast();
        string column = promptColumn ?? "";
        if (DatasetCache.TryGetRowCount(key, entry.FileHash, column, out long cached))
        {
            return cached;
        }
        string rcKey = $"{key}|{entry.FileHash}|rc|{column}";
        return _rowCountFlight.GetOrBuild(rcKey, () =>
        {
            if (DatasetCache.TryGetRowCount(key, entry.FileHash, column, out long settled))
            {
                return settled;
            }
            long count = Backend.CountRows(entry.Path, SqlFilter.None);
            DatasetCache.StoreRowCount(key, entry.FileHash, column, count);
            return count;
        });
    }

    public static bool TryGetFilteredCount(DatasetEntry entry, SqlFilter filter, out long count)
        => DatasetCache.TryGetFilteredCount(DatasetCache.FilteredCountKey(entry, filter), out count);

    public static long CountRowsFiltered(DatasetEntry entry, SqlFilter filter)
    {
        string key = DatasetCache.FilteredCountKey(entry, filter);
        if (DatasetCache.TryGetFilteredCount(key, out long cached))
        {
            return cached;
        }
        long count = _filteredCountFlight.GetOrBuild(key, () =>
        {
            if (DatasetCache.TryGetFilteredCount(key, out long settled))
            {
                return settled;
            }
            long built = Backend.CountRows(entry.Path, filter);
            DatasetCache.StoreFilteredCount(key, built);
            return built;
        });
        DatasetCache.PersistIfDirty();
        return count;
    }

    public static long CountRowsFiltered(DatasetEntry entry, SqlFilter filter, IDatasetReader reader)
    {
        string key = DatasetCache.FilteredCountKey(entry, filter);
        if (DatasetCache.TryGetFilteredCount(key, out long cached))
        {
            return cached;
        }
        return _filteredCountFlight.GetOrBuild(key, () =>
        {
            if (DatasetCache.TryGetFilteredCount(key, out long settled))
            {
                return settled;
            }
            long built = reader.CountRows(entry.Path, filter);
            DatasetCache.StoreFilteredCount(key, built);
            return built;
        });
    }

    public static void WarmFilteredCounts(IReadOnlyList<(DatasetEntry Entry, SqlFilter Filter)> requests)
        => DatasetWarmer.WarmFilteredCounts(Backend, requests);

    public static bool TryGetCachedRowCount(DatasetEntry entry, string promptColumn, out long count)
        => DatasetCache.TryGetRowCount(entry.Name.ToLowerFast(), entry.FileHash, promptColumn ?? "", out count);

    public static List<DatasetInfo> GetDatasetsInfo(bool includeRowCounts = false)
    {
        List<DatasetInfo> result = [];
        foreach (DatasetEntry entry in Datasets.Values.OrderBy(e => e.Name, StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                ColumnSchema schema = GetSchema(entry);
                string resolved = PromptColumnResolver.Resolve(GetConfiguredPromptColumn(entry.Name), schema);
                long? rowCount = TryGetCachedRowCount(entry, resolved, out long cachedCount) ? cachedCount : null;
                if (rowCount is null && includeRowCounts)
                {
                    try
                    {
                        rowCount = GetRowCount(entry, resolved);
                    }
                    catch
                    {
                    }
                }
                result.Add(new DatasetInfo(entry.Name, [.. schema.VisibleColumns], resolved, GetConfiguredPromptColumn(entry.Name), [.. GetConfiguredTagColumns(entry.Name)], rowCount, null));
            }
            catch (Exception ex)
            {
                result.Add(new DatasetInfo(entry.Name, [], null, GetConfiguredPromptColumn(entry.Name), [.. GetConfiguredTagColumns(entry.Name)], null, ex.Message));
            }
        }
        DatasetCache.PersistIfDirty();
        return result;
    }

    public static (bool Success, long? RowCount, string Error) GetUsableRowCount(string name)
    {
        DatasetEntry entry = Resolve(name);
        if (entry is null)
        {
            return (false, null, $"Unknown dataset '{name}'.");
        }
        try
        {
            ColumnSchema schema = GetSchema(entry);
            string resolved = PromptColumnResolver.Resolve(GetConfiguredPromptColumn(entry.Name), schema);
            long count = GetRowCount(entry, resolved);
            DatasetCache.PersistIfDirty();
            return (true, count, null);
        }
        catch (Exception ex)
        {
            return (false, null, ex.Message);
        }
    }

    public static (bool Success, List<string> Columns, List<List<string>> Rows, string Error) PreviewDataset(string name, int limit)
    {
        DatasetEntry entry = Resolve(name);
        if (entry is null)
        {
            return (false, null, null, $"Unknown dataset '{name}'.");
        }
        string key = entry.Name.ToLowerFast();
        if (DatasetCache.TryGetPreview(key, entry.FileHash, limit, out DatasetCache.PreviewData cached))
        {
            DatasetCache.PreviewData visible = StripInternalPreviewColumns(cached);
            if (!ReferenceEquals(visible, cached))
            {
                DatasetCache.StorePreview(key, entry.FileHash, visible);
                DatasetCache.PersistIfDirty();
            }
            return (true, visible.Columns, visible.Rows, null);
        }
        try
        {
            string previewKey = $"{key}|{entry.FileHash}|preview|{limit}";
            DatasetCache.PreviewData data = _previewFlight.GetOrBuild(previewKey, () =>
            {
                if (DatasetCache.TryGetPreview(key, entry.FileHash, limit, out DatasetCache.PreviewData settled))
                {
                    DatasetCache.PreviewData visible = StripInternalPreviewColumns(settled);
                    if (!ReferenceEquals(visible, settled))
                    {
                        DatasetCache.StorePreview(key, entry.FileHash, visible);
                    }
                    return visible;
                }
                (List<string> columns, List<List<string>> rows) = Backend.GetSampleRows(entry.Path, limit);
                (columns, rows) = ColumnSchema.StripCompanions(columns, rows);
                DatasetCache.PreviewData fresh = new(limit, columns, rows);
                DatasetCache.StorePreview(key, entry.FileHash, fresh);
                return fresh;
            });
            data = StripInternalPreviewColumns(data);
            DatasetCache.PersistIfDirty();
            return (true, data.Columns, data.Rows, null);
        }
        catch (Exception ex)
        {
            return (false, null, null, ex.Message);
        }
    }

    private static DatasetCache.PreviewData StripInternalPreviewColumns(DatasetCache.PreviewData preview)
    {
        (List<string> columns, List<List<string>> rows) = ColumnSchema.StripCompanions(preview.Columns, preview.Rows);
        return ReferenceEquals(columns, preview.Columns) ? preview : new DatasetCache.PreviewData(preview.Limit, columns, rows);
    }

    public static bool ClearPreviewCache(string name)
    {
        DatasetEntry entry = Resolve(name);
        if (entry is null)
        {
            return false;
        }
        DatasetCache.ClearPreview(entry.Name.ToLowerFast());
        DatasetCache.PersistIfDirty();
        return true;
    }

    public static int WarmAll()
        => IsActive ? DatasetWarmer.WarmAll(Backend, [.. Datasets.Values], DefaultPreviewLimit) : 0;

    public static void Sync()
    {
        if (!IsActive)
        {
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
            bool contentChanged = false;
            foreach (string datasetPath in DatasetScanner.Enumerate(root))
            {
                string relative = Path.GetRelativePath(root, datasetPath);
                string name = DatasetNaming.ToName(relative);
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

    private const long MaxPlaceholderBytes = 256;

    public static (int Removed, string Error) CleanTempFiles()
    {
        try
        {
            string wildcardDir = WildcardsHelper.Folder;
            if (string.IsNullOrWhiteSpace(wildcardDir) || !Directory.Exists(wildcardDir))
            {
                return (0, "");
            }
            int removed = 0;
            foreach (string file in Directory.EnumerateFiles(wildcardDir, "*.txt", SearchOption.AllDirectories))
            {
                try
                {
                    if (new FileInfo(file).Length > MaxPlaceholderBytes || !IsLegacyPlaceholder(File.ReadAllText(file)))
                    {
                        continue;
                    }
                    File.Delete(file);
                    removed++;
                }
                catch
                {
                }
            }
            if (removed > 0)
            {
                Logs.Info($"Quarry: removed {removed} legacy placeholder wildcard file(s) from '{wildcardDir}'.");
            }
            return (removed, "");
        }
        catch (Exception ex)
        {
            Logs.Warning($"Quarry: failed to clean temp files: {ex.Message}");
            return (0, ex.Message);
        }
    }

    public static bool IsLegacyPlaceholder(string content)
    {
        string trimmed = content.Trim();
        return trimmed.Length > 0
            && !trimmed.Contains('\n')
            && trimmed.StartsWith('#')
            && trimmed.Contains("placeholder", StringComparison.OrdinalIgnoreCase)
            && trimmed.Contains("do not edit", StringComparison.OrdinalIgnoreCase)
            && !trimmed.Contains("whattheduck", StringComparison.OrdinalIgnoreCase);
    }

    private static string ComputeHash(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                DirectoryInfo dir = new(path);
                long newest = dir.LastWriteTimeUtc.Ticks;
                int count = 0;
                foreach (FileSystemInfo child in dir.EnumerateFileSystemInfos())
                {
                    count++;
                    long ticks = child.LastWriteTimeUtc.Ticks;
                    if (ticks > newest)
                    {
                        newest = ticks;
                    }
                }
                return $"dir:{newest}:{count}";
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

public sealed record DatasetInfo(
    string Name,
    IReadOnlyList<ColumnInfo> Columns,
    string ResolvedPromptColumn,
    string ConfiguredPromptColumn,
    IReadOnlyList<string> ConfiguredTagColumns,
    long? RowCount,
    string Error);
