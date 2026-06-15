using System.IO;
using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;
using SwarmUI.Core;
using SwarmUI.Utils;

namespace Quarry;

public static class DatasetCache
{
    private const int CacheVersion = 1;
    private static readonly ConcurrentDictionary<string, CacheEntry> Cache = new();
    private static readonly ConcurrentDictionary<string, long> FilteredCounts = new();
    private static readonly object CacheLock = new();
    private static volatile bool _cacheDirty;

    public static string CacheFolder
    {
        get
        {
            string root = DatasetManager.ExtensionFolder;
            if (string.IsNullOrWhiteSpace(root))
            {
                root = Program.DataDir;
            }
            if (string.IsNullOrWhiteSpace(root))
            {
                root = ".";
            }
            return Path.GetFullPath(Path.Combine(root, ".cache"));
        }
    }

    private static string CacheFilePath => Path.Combine(CacheFolder, "datasets.json");

    public sealed record PreviewData(int Limit, List<string> Columns, List<List<string>> Rows)
    {
        public bool Satisfies(int limit) => Rows.Count >= limit || Rows.Count < Limit;
    }

    private sealed record CacheEntry
    {
        public required string Hash { get; init; }
        public ColumnSchema Schema { get; init; }
        public bool HasRowCount { get; init; }
        public string RowCountColumn { get; init; }
        public long RowCount { get; init; }
        public PreviewData Preview { get; init; }
    }

    public static bool TryGetSchema(string key, string hash, out ColumnSchema schema)
    {
        if (Cache.TryGetValue(key, out CacheEntry cached) && cached.Hash == hash && cached.Schema is not null)
        {
            schema = cached.Schema;
            return true;
        }
        schema = null;
        return false;
    }

    public static bool TryGetRowCount(string key, string hash, string promptColumn, out long count)
    {
        count = 0;
        if (Cache.TryGetValue(key, out CacheEntry cached) && cached.Hash == hash
            && cached.HasRowCount && cached.RowCountColumn == promptColumn)
        {
            count = cached.RowCount;
            return true;
        }
        return false;
    }

    public static bool TryGetPreview(string key, string hash, int limit, out PreviewData preview)
    {
        if (Cache.TryGetValue(key, out CacheEntry cached) && cached.Hash == hash
            && cached.Preview is not null && cached.Preview.Satisfies(limit))
        {
            preview = cached.Preview;
            return true;
        }
        preview = null;
        return false;
    }

    public static bool IsFullyCached(string key, string hash, string configuredColumn, int limit)
    {
        if (!Cache.TryGetValue(key, out CacheEntry cached) || cached.Hash != hash
            || cached.Schema is null || !cached.HasRowCount
            || cached.Preview is null || !cached.Preview.Satisfies(limit))
        {
            return false;
        }
        string resolved = PromptColumnResolver.Resolve(configuredColumn, cached.Schema) ?? "";
        return cached.RowCountColumn == resolved;
    }

    public static void StoreSchema(string key, string hash, ColumnSchema schema)
    {
        lock (CacheLock)
        {
            Cache[key] = BaseFor(key, hash) with { Schema = schema };
            _cacheDirty = true;
        }
    }

    public static void StoreRowCount(string key, string hash, string promptColumn, long count)
    {
        lock (CacheLock)
        {
            Cache[key] = BaseFor(key, hash) with { HasRowCount = true, RowCountColumn = promptColumn, RowCount = count };
            _cacheDirty = true;
        }
    }

    public static void StorePreview(string key, string hash, PreviewData preview)
    {
        lock (CacheLock)
        {
            Cache[key] = BaseFor(key, hash) with { Preview = preview };
            _cacheDirty = true;
        }
    }

    private static CacheEntry BaseFor(string key, string hash) =>
        Cache.TryGetValue(key, out CacheEntry existing) && existing.Hash == hash
            ? existing
            : new CacheEntry { Hash = hash };

    public static string FilteredCountKey(DatasetEntry entry, SqlFilter filter)
        => $"{entry.Name.ToLowerFast()}|{entry.FileHash}|{filter.CacheKey}";

    public static bool TryGetFilteredCount(string filteredCountKey, out long count)
        => FilteredCounts.TryGetValue(filteredCountKey, out count);

    public static void StoreFilteredCount(string filteredCountKey, long count)
    {
        FilteredCounts[filteredCountKey] = count;
        _cacheDirty = true;
    }

    public static void Prune(IReadOnlyDictionary<string, DatasetEntry> liveDatasets)
    {
        foreach (string key in FilteredCounts.Keys.ToList())
        {
            int firstSep = key.IndexOf('|');
            int secondSep = firstSep < 0 ? -1 : key.IndexOf('|', firstSep + 1);
            if (secondSep < 0)
            {
                FilteredCounts.TryRemove(key, out _);
                continue;
            }
            string name = key[..firstSep];
            string hash = key[(firstSep + 1)..secondSep];
            if (!liveDatasets.TryGetValue(name, out DatasetEntry entry) || entry.FileHash != hash)
            {
                FilteredCounts.TryRemove(key, out _);
            }
        }
    }

    public static void Remove(string key)
    {
        if (Cache.TryRemove(key, out _))
        {
            _cacheDirty = true;
        }
    }

    public static void ClearPreview(string key)
    {
        lock (CacheLock)
        {
            if (Cache.TryGetValue(key, out CacheEntry cached) && cached.Preview is not null)
            {
                Cache[key] = cached with { Preview = null };
                _cacheDirty = true;
            }
        }
    }

    public static void InvalidateIfChanged(string key, string hash)
    {
        if (Cache.TryGetValue(key, out CacheEntry cached) && cached.Hash != hash)
        {
            Cache.TryRemove(key, out _);
            _cacheDirty = true;
        }
    }

    public static void PersistIfDirty()
    {
        lock (CacheLock)
        {
            if (!_cacheDirty)
            {
                return;
            }
            try
            {
                Save();
                _cacheDirty = false;
            }
            catch (Exception ex)
            {
                Logs.Warning($"Quarry: failed to persist dataset cache: {ex.Message}");
            }
        }
    }

    private static void Save()
    {
        JObject datasets = [];
        foreach ((string key, CacheEntry entry) in Cache)
        {
            JObject obj = new() { ["hash"] = entry.Hash };
            if (entry.Schema is not null)
            {
                JArray columns = [];
                foreach (ColumnInfo column in entry.Schema.Columns)
                {
                    columns.Add(new JObject { ["name"] = column.Name, ["kind"] = column.Kind.ToString() });
                }
                obj["schema"] = columns;
            }
            if (entry.HasRowCount)
            {
                obj["rowCountColumn"] = entry.RowCountColumn;
                obj["rowCount"] = entry.RowCount;
            }
            if (entry.Preview is not null)
            {
                obj["preview"] = new JObject
                {
                    ["limit"] = entry.Preview.Limit,
                    ["columns"] = ToJArray(entry.Preview.Columns),
                    ["rows"] = ToRowsArray(entry.Preview.Rows),
                };
            }
            datasets[key] = obj;
        }
        JObject filteredCounts = [];
        foreach ((string filterKey, long value) in FilteredCounts)
        {
            filteredCounts[filterKey] = value;
        }
        JObject root = new() { ["version"] = CacheVersion, ["datasets"] = datasets, ["filteredCounts"] = filteredCounts };
        string directory = Path.GetDirectoryName(CacheFilePath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }
        string temp = $"{CacheFilePath}.tmp";
        File.WriteAllText(temp, root.ToString());
        File.Move(temp, CacheFilePath, overwrite: true);
    }

    public static void Load()
    {
        try
        {
            if (!File.Exists(CacheFilePath))
            {
                return;
            }
            JObject root = JObject.Parse(File.ReadAllText(CacheFilePath));
            if (root.Value<int?>("version") != CacheVersion || root["datasets"] is not JObject datasets)
            {
                return;
            }
            foreach (JProperty property in datasets.Properties())
            {
                if (property.Value is not JObject obj)
                {
                    continue;
                }
                string hash = obj.Value<string>("hash");
                if (string.IsNullOrEmpty(hash))
                {
                    continue;
                }
                Cache[property.Name] = new CacheEntry
                {
                    Hash = hash,
                    Schema = ReadSchema(obj["schema"] as JArray),
                    HasRowCount = obj["rowCount"] is not null,
                    RowCountColumn = obj.Value<string>("rowCountColumn") ?? "",
                    RowCount = obj.Value<long?>("rowCount") ?? 0,
                    Preview = ReadPreview(obj["preview"] as JObject),
                };
            }
            if (root["filteredCounts"] is JObject filteredCounts)
            {
                foreach (JProperty property in filteredCounts.Properties())
                {
                    long? value = property.Value?.Value<long?>();
                    if (value is not null)
                    {
                        FilteredCounts[property.Name] = value.Value;
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Logs.Warning($"Quarry: failed to load dataset cache: {ex.Message}");
        }
    }

    private static ColumnSchema ReadSchema(JArray columns)
    {
        if (columns is null)
        {
            return null;
        }
        List<ColumnInfo> result = [];
        foreach (JToken token in columns)
        {
            string name = token.Value<string>("name");
            if (string.IsNullOrEmpty(name))
            {
                continue;
            }
            ColumnKind kind = string.Equals(token.Value<string>("kind"), nameof(ColumnKind.List), StringComparison.OrdinalIgnoreCase)
                ? ColumnKind.List
                : ColumnKind.Scalar;
            result.Add(new ColumnInfo(name, kind));
        }
        return new ColumnSchema(result);
    }

    private static PreviewData ReadPreview(JObject preview)
    {
        if (preview is null)
        {
            return null;
        }
        int limit = preview.Value<int?>("limit") ?? 0;
        List<string> columns = preview["columns"] is JArray cols
            ? [.. cols.Select(c => c.Value<string>() ?? "")]
            : [];
        List<List<string>> rows = [];
        if (preview["rows"] is JArray rowArr)
        {
            foreach (JToken row in rowArr)
            {
                rows.Add(row is JArray cells ? [.. cells.Select(c => c.Value<string>() ?? "")] : []);
            }
        }
        return new PreviewData(limit, columns, rows);
    }

    private static JArray ToJArray(IEnumerable<string> values)
    {
        JArray array = [];
        foreach (string value in values)
        {
            array.Add(value);
        }
        return array;
    }

    private static JArray ToRowsArray(IEnumerable<List<string>> rows)
    {
        JArray array = [];
        foreach (List<string> row in rows)
        {
            array.Add(ToJArray(row));
        }
        return array;
    }
}
