using System.IO;
using FreneticUtilities.FreneticExtensions;
using SwarmUI.Core;
using SwarmUI.Utils;

namespace Quarry;

/// <summary>A dataset the extension serves as a wildcard: its wildcard <see cref="WildcardName"/>, the
/// absolute <see cref="Path"/> to the data file/dataset, and a cheap change <see cref="FileHash"/>.</summary>
public sealed record DatasetEntry(string WildcardName, string Path, string FileHash);

/// <summary>Orchestrates the datasets folder: scans it, mirrors each dataset to a placeholder <c>.txt</c>
/// in the Wildcards folder (never overwriting), tracks a name → dataset map, caches per-dataset schema,
/// and owns the shared <see cref="DuckDbQueryBackend"/>. Mirrors WhatTheDuck's DatadumpManager pattern.</summary>
public static class DatasetManager
{
    private const string PlaceholderContent = "# Quarry placeholder - do not edit\n";

    public static bool Enabled { get; set; }

    public static string DatasetsFolder { get; set; } = "";

    public static bool IsActive => Enabled && !string.IsNullOrWhiteSpace(DatasetsFolder);

    // key = wildcard name lowercased
    private static readonly ConcurrentDictionary<string, DatasetEntry> Datasets = new();
    private static readonly ConcurrentDictionary<string, (string Hash, ColumnSchema Schema)> SchemaCache = new();
    private static readonly ConcurrentDictionary<string, (string Hash, long Count)> RowCountCache = new();
    private static readonly Dictionary<string, string> PromptColumns = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, List<string>> TagColumns = new(StringComparer.OrdinalIgnoreCase);
    private static readonly object PromptColumnsLock = new();

    private static DuckDbQueryBackend _backend;

    /// <summary>The shared DuckDB query engine, created on first use.</summary>
    public static DuckDbQueryBackend Backend => _backend ??= new DuckDbQueryBackend();

    public static int Count => Datasets.Count;

    public static void Initialize()
    {
        if (IsActive)
        {
            SyncPlaceholders();
        }
        Program.ModelRefreshEvent += OnModelRefresh;
    }

    public static void Shutdown()
    {
        Program.ModelRefreshEvent -= OnModelRefresh;
        _backend?.Dispose();
        _backend = null;
    }

    private static void OnModelRefresh()
    {
        if (IsActive)
        {
            SyncPlaceholders();
        }
    }

    /// <summary>Resolves a wildcard name to its dataset, or null when it is not one of ours.</summary>
    public static DatasetEntry Resolve(string wildcardName)
    {
        if (!IsActive || wildcardName is null)
        {
            return null;
        }
        return Datasets.TryGetValue(wildcardName.ToLowerFast(), out DatasetEntry entry) ? entry : null;
    }

    public static string GetConfiguredPromptColumn(string wildcardName)
    {
        lock (PromptColumnsLock)
        {
            return PromptColumns.TryGetValue(wildcardName, out string column) ? column : null;
        }
    }

    public static void SetPromptColumns(IReadOnlyDictionary<string, string> columns)
    {
        lock (PromptColumnsLock)
        {
            PromptColumns.Clear();
            foreach ((string name, string column) in columns)
            {
                if (!string.IsNullOrWhiteSpace(column))
                {
                    PromptColumns[name] = column;
                }
            }
        }
    }

    public static IReadOnlyDictionary<string, string> GetPromptColumnsSnapshot()
    {
        lock (PromptColumnsLock)
        {
            return new Dictionary<string, string>(PromptColumns);
        }
    }

    /// <summary>The columns a user picked as "tag" columns for a dataset, or an empty list when none are set.
    /// The <c>tags</c> keyword in a wildcard filter searches across all of them as one merged column.</summary>
    public static IReadOnlyList<string> GetConfiguredTagColumns(string wildcardName)
    {
        lock (PromptColumnsLock)
        {
            return TagColumns.TryGetValue(wildcardName, out List<string> columns) ? [.. columns] : [];
        }
    }

    public static void SetTagColumns(IReadOnlyDictionary<string, IReadOnlyList<string>> columns)
    {
        lock (PromptColumnsLock)
        {
            TagColumns.Clear();
            foreach ((string name, IReadOnlyList<string> cols) in columns)
            {
                List<string> kept = cols is null ? [] : [.. cols.Where(c => !string.IsNullOrWhiteSpace(c))];
                if (kept.Count > 0)
                {
                    TagColumns[name] = kept;
                }
            }
        }
    }

    public static IReadOnlyDictionary<string, IReadOnlyList<string>> GetTagColumnsSnapshot()
    {
        lock (PromptColumnsLock)
        {
            return TagColumns.ToDictionary(kv => kv.Key, kv => (IReadOnlyList<string>)[.. kv.Value]);
        }
    }

    /// <summary>A snapshot of all currently known datasets, for fanning a glob/comma reference out over them.</summary>
    public static IReadOnlyCollection<DatasetEntry> AllDatasets => [.. Datasets.Values];

    /// <summary>Returns the dataset's schema, cached until the underlying file changes.</summary>
    public static ColumnSchema GetSchema(DatasetEntry entry)
    {
        string key = entry.WildcardName.ToLowerFast();
        if (SchemaCache.TryGetValue(key, out (string Hash, ColumnSchema Schema) cached) && cached.Hash == entry.FileHash)
        {
            return cached.Schema;
        }
        ColumnSchema schema = Backend.GetSchema(entry.Path);
        SchemaCache[key] = (entry.FileHash, schema);
        return schema;
    }

    /// <summary>Returns the dataset's total (unfiltered) row count, cached until the underlying file changes.</summary>
    public static long GetRowCount(DatasetEntry entry)
    {
        string key = entry.WildcardName.ToLowerFast();
        if (RowCountCache.TryGetValue(key, out (string Hash, long Count) cached) && cached.Hash == entry.FileHash)
        {
            return cached.Count;
        }
        long count = Backend.CountRows(entry.Path, SqlFilter.None);
        RowCountCache[key] = (entry.FileHash, count);
        return count;
    }

    /// <summary>Per-dataset info for the settings UI: columns (name + list-ness) and the resolved prompt column.</summary>
    public static List<DatasetInfo> GetDatasetsInfo()
    {
        List<DatasetInfo> result = [];
        foreach (DatasetEntry entry in Datasets.Values.OrderBy(e => e.WildcardName, StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                ColumnSchema schema = GetSchema(entry);
                string resolved = PromptColumnResolver.Resolve(GetConfiguredPromptColumn(entry.WildcardName), schema);
                long? rowCount = null;
                try
                {
                    rowCount = GetRowCount(entry);
                }
                catch
                {
                    // Row count is a best-effort display value; a count failure must not hide a readable dataset.
                }
                result.Add(new DatasetInfo(entry.WildcardName, [.. schema.Columns], resolved, GetConfiguredPromptColumn(entry.WildcardName), [.. GetConfiguredTagColumns(entry.WildcardName)], rowCount, null));
            }
            catch (Exception ex)
            {
                result.Add(new DatasetInfo(entry.WildcardName, [], null, GetConfiguredPromptColumn(entry.WildcardName), [.. GetConfiguredTagColumns(entry.WildcardName)], null, ex.Message));
            }
        }
        return result;
    }

    /// <summary>Reads up to <paramref name="limit"/> rows from a dataset for the preview UI. Resolves the
    /// wildcard name to its file, then delegates to the backend. Returns success plus the column names and
    /// row values, or a failure with an error message (unknown dataset, or a query/IO error).</summary>
    public static (bool Success, List<string> Columns, List<List<string>> Rows, string Error) PreviewDataset(string wildcardName, int limit)
    {
        DatasetEntry entry = Resolve(wildcardName);
        if (entry is null)
        {
            return (false, null, null, $"Unknown dataset '{wildcardName}'.");
        }
        try
        {
            (List<string> columns, List<List<string>> rows) = Backend.GetSampleRows(entry.Path, limit);
            return (true, columns, rows, null);
        }
        catch (Exception ex)
        {
            return (false, null, null, ex.Message);
        }
    }

    /// <summary>Scans the datasets folder and creates placeholder files in the Wildcards folder; never
    /// overwrites existing files. Drops datasets no longer present and invalidates changed schemas.</summary>
    public static void SyncPlaceholders()
    {
        if (!IsActive)
        {
            Datasets.Clear();
            SchemaCache.Clear();
            RowCountCache.Clear();
            return;
        }
        try
        {
            string root = DatasetsFolder;
            string wildcardDir = WildcardsHelper.Folder;
            if (!Directory.Exists(root))
            {
                Logs.Warning($"Quarry: datasets folder does not exist: '{root}'");
                return;
            }
            Directory.CreateDirectory(wildcardDir);
            HashSet<string> seen = [];
            int created = 0;
            // Tracks whether any dataset was added, removed, or had its file change. If so we rebuild the
            // DuckDB connection below: a regenerated Lance dataset keeps the same path but gets new fragment
            // files, and the old connection's cached manifest would still point at the deleted ones.
            bool contentChanged = false;
            foreach (string datasetPath in DatasetScanner.Enumerate(root))
            {
                string relative = Path.GetRelativePath(root, datasetPath);
                string name = WildcardNaming.ToWildcardName(relative);
                string key = name.ToLowerFast();
                if (!seen.Add(key))
                {
                    Logs.Warning($"Quarry: multiple files map to wildcard '{name}'; keeping the first, ignoring '{relative}'.");
                    continue;
                }
                string hash = ComputeHash(datasetPath);
                if (SchemaCache.TryGetValue(key, out (string Hash, ColumnSchema Schema) cached) && cached.Hash != hash)
                {
                    SchemaCache.TryRemove(key, out _);
                }
                if (RowCountCache.TryGetValue(key, out (string Hash, long Count) cachedCount) && cachedCount.Hash != hash)
                {
                    RowCountCache.TryRemove(key, out _);
                }
                if (!Datasets.TryGetValue(key, out DatasetEntry previous) || previous.FileHash != hash)
                {
                    contentChanged = true;
                }
                Datasets[key] = new DatasetEntry(name, datasetPath, hash);

                string placeholderRelative = WildcardNaming.ToPlaceholderRelativePath(name).Replace('/', Path.DirectorySeparatorChar);
                string placeholderPath = Path.Combine(wildcardDir, placeholderRelative);
                string placeholderDir = Path.GetDirectoryName(placeholderPath);
                if (!string.IsNullOrEmpty(placeholderDir))
                {
                    Directory.CreateDirectory(placeholderDir);
                }
                if (!File.Exists(placeholderPath))
                {
                    File.WriteAllText(placeholderPath, PlaceholderContent);
                    created++;
                }
            }
            foreach (string key in Datasets.Keys.Where(k => !seen.Contains(k)).ToList())
            {
                Datasets.TryRemove(key, out _);
                SchemaCache.TryRemove(key, out _);
                RowCountCache.TryRemove(key, out _);
                contentChanged = true;
            }
            // A dataset's files changed on disk, so drop the DuckDB connection's cached metadata (notably
            // stale Lance manifests pointing at regenerated, now-missing fragment files). No-op when the
            // backend was never used (e.g. at startup, before the first query).
            if (contentChanged)
            {
                _backend?.Reset();
            }
            Logs.Info($"Quarry: synced {Datasets.Count} dataset(s) ({created} placeholder(s) created).");
        }
        catch (Exception ex)
        {
            Logs.Error($"Quarry: error syncing placeholders: {ex.ReadableString()}");
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
            SyncPlaceholders();
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

/// <summary>Settings-UI view of one dataset: its columns, the resolved prompt column (what would be used
/// now), the explicitly configured column (if any), the total row count (null when unknown), and an error
/// message if the schema couldn't be read.</summary>
public sealed record DatasetInfo(
    string Name,
    IReadOnlyList<ColumnInfo> Columns,
    string ResolvedPromptColumn,
    string ConfiguredPromptColumn,
    IReadOnlyList<string> ConfiguredTagColumns,
    long? RowCount,
    string Error);
