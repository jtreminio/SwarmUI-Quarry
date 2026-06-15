using System.IO;
using FreneticUtilities.FreneticExtensions;
using Newtonsoft.Json.Linq;
using SwarmUI.Core;
using SwarmUI.Utils;

namespace Quarry;

/// <summary>A dataset the extension serves as a <c>&lt;q:&gt;</c> reference: its <see cref="WildcardName"/>
/// (the name used in <c>&lt;q:NAME&gt;</c>), the absolute <see cref="Path"/> to the data file/dataset, and a
/// cheap change <see cref="FileHash"/>.</summary>
public sealed record DatasetEntry(string WildcardName, string Path, string FileHash);

/// <summary>Orchestrates the datasets folder: scans it, tracks a name → dataset map, caches per-dataset
/// schema, and owns the shared <see cref="DuckDbQueryBackend"/>. Quarry serves its own <c>&lt;q:&gt;</c> tag
/// and is fully detached from SwarmUI's Wildcards folder — it writes nothing there (see
/// <see cref="CleanupLegacyPlaceholders"/> for one-time removal of files an older version mirrored).</summary>
public static class DatasetManager
{
    /// <summary>Exact body of the placeholder <c>.txt</c> files older versions wrote into the Wildcards folder.
    /// Used only to recognize and delete them on startup — see <see cref="CleanupLegacyPlaceholders"/>.</summary>
    private const string PlaceholderContent = "# Quarry placeholder - do not edit\n";

    public static bool Enabled { get; set; }

    public static string DatasetsFolder { get; set; } = "";

    public static bool IsActive => Enabled && !string.IsNullOrWhiteSpace(DatasetsFolder);

    // key = wildcard name lowercased
    private static readonly ConcurrentDictionary<string, DatasetEntry> Datasets = new();
    // Per-file derived data (schema, usable row count, preview sample), all keyed by the file's hash and
    // persisted to disk so a restart doesn't recompute them for unchanged files. See the Persistent cache region.
    private static readonly ConcurrentDictionary<string, CacheEntry> Cache = new();
    private static readonly object CacheLock = new();
    private static volatile bool _cacheDirty;
    private const int CacheVersion = 1;
    /// <summary>Number of preview rows the UI requests and that warming pre-caches. Keep in sync with the
    /// preview limit the API/frontend use, so a warmed preview is a cache hit for the real request.</summary>
    public const int DefaultPreviewLimit = 100;
    private static readonly Dictionary<string, string> PromptColumns = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, List<string>> TagColumns = new(StringComparer.OrdinalIgnoreCase);
    private static readonly object PromptColumnsLock = new();

    private static DuckDbQueryBackend _backend;

    /// <summary>The shared DuckDB query engine, created on first use.</summary>
    public static DuckDbQueryBackend Backend => _backend ??= new DuckDbQueryBackend();

    public static int Count => Datasets.Count;

    public static void Initialize()
    {
        // Seed the in-memory cache from the persisted file before the first Sync, so unchanged files reuse
        // their stored schema / row count / preview instead of recomputing them this session.
        LoadCache();
        // One-time housekeeping: an earlier Quarry mirrored every dataset to a placeholder .txt in the
        // Wildcards folder. We no longer do that, so remove any that are still lying around.
        CleanupLegacyPlaceholders();
        if (IsActive)
        {
            Sync();
        }
        Program.ModelRefreshEvent += OnModelRefresh;
    }

    public static void Shutdown()
    {
        Program.ModelRefreshEvent -= OnModelRefresh;
        PersistCacheIfDirty();
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

    /// <summary>A snapshot of every known dataset's <c>&lt;q:&gt;</c> name — the list a plain reference is fuzzy
    /// matched against (replacing the Wildcards folder we used to lean on).</summary>
    public static IReadOnlyList<string> AllDatasetNames => [.. Datasets.Values.Select(e => e.WildcardName)];

    /// <summary>Returns the dataset's schema, cached (in memory and on disk) until the underlying file changes.</summary>
    public static ColumnSchema GetSchema(DatasetEntry entry)
    {
        string key = entry.WildcardName.ToLowerFast();
        if (Cache.TryGetValue(key, out CacheEntry cached) && cached.Hash == entry.FileHash && cached.Schema is not null)
        {
            return cached.Schema;
        }
        ColumnSchema schema = Backend.GetSchema(entry.Path);
        StoreSchema(key, entry.FileHash, schema);
        return schema;
    }

    /// <summary>Returns the number of rows whose <paramref name="promptColumn"/> is non-empty — i.e. the rows
    /// this dataset can actually contribute as wildcard picks — so the UI count matches what a query yields and
    /// never includes blank rows. Cached until the underlying file OR the resolved prompt column changes (the
    /// column choice affects the count, but not the file hash). A null/empty prompt column (a dataset with no
    /// readable columns) falls back to the raw total.</summary>
    public static long GetRowCount(DatasetEntry entry, string promptColumn)
    {
        string key = entry.WildcardName.ToLowerFast();
        string column = promptColumn ?? "";
        if (Cache.TryGetValue(key, out CacheEntry cached) && cached.Hash == entry.FileHash
            && cached.HasRowCount && cached.RowCountColumn == column)
        {
            return cached.RowCount;
        }
        SqlFilter filter = string.IsNullOrEmpty(promptColumn)
            ? SqlFilter.None
            : SqlFilterBuilder.NonEmptyPrompt(promptColumn);
        long count = Backend.CountRows(entry.Path, filter);
        StoreRowCount(key, entry.FileHash, column, count);
        return count;
    }

    /// <summary>Reads a dataset's usable-pick row count from the cache only, never scanning. Returns false when
    /// the cache holds no count for this file's current hash and the given prompt column (never warmed/previewed,
    /// file changed, or the resolved column changed). Lets counts computed in a prior session — loaded from disk
    /// on startup — show on first load without a Refresh.</summary>
    public static bool TryGetCachedRowCount(DatasetEntry entry, string promptColumn, out long count)
    {
        count = 0;
        string column = promptColumn ?? "";
        if (Cache.TryGetValue(entry.WildcardName.ToLowerFast(), out CacheEntry cached) && cached.Hash == entry.FileHash
            && cached.HasRowCount && cached.RowCountColumn == column)
        {
            count = cached.RowCount;
            return true;
        }
        return false;
    }

    /// <summary>Per-dataset info for the settings UI: columns (name + list-ness) and the resolved prompt column.
    /// Reading the schema is cheap (DuckDB samples it, bounded regardless of file size), so it is always
    /// included. A row count is a full-scan that scales with file size, so it is surfaced from the cache
    /// whenever one exists (e.g. warmed in a prior session and loaded from disk on startup) — letting counts
    /// show on first load without a Refresh. Only when <paramref name="includeRowCounts"/> is set (the Refresh
    /// path, after a warm) is an uncached count computed by a fresh scan; otherwise it is left null and loaded
    /// lazily when the user previews that dataset (see <see cref="GetUsableRowCount"/>). Eagerly counting every
    /// dataset here is what made an initial load hang, and made large datasets appear to never load.</summary>
    public static List<DatasetInfo> GetDatasetsInfo(bool includeRowCounts = false)
    {
        List<DatasetInfo> result = [];
        foreach (DatasetEntry entry in Datasets.Values.OrderBy(e => e.WildcardName, StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                ColumnSchema schema = GetSchema(entry);
                string resolved = PromptColumnResolver.Resolve(GetConfiguredPromptColumn(entry.WildcardName), schema);
                // Always show a cached count if we have one (so prior-session counts appear without a Refresh);
                // only scan for a missing one when explicitly asked (the Refresh path, which warms first).
                long? rowCount = TryGetCachedRowCount(entry, resolved, out long cachedCount) ? cachedCount : null;
                if (rowCount is null && includeRowCounts)
                {
                    try
                    {
                        rowCount = GetRowCount(entry, resolved);
                    }
                    catch
                    {
                        // Row count is a best-effort display value; a count failure must not hide a readable dataset.
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
        PersistCacheIfDirty();
        return result;
    }

    /// <summary>Lazily computes one dataset's usable-pick row count (rows whose resolved prompt column is
    /// non-empty) — the value the UI shows in its "Rows" column. Resolves the name to its file and prompt
    /// column, then counts (cached until the file or prompt column changes). Returns a failure with a message
    /// for an unknown dataset or a query/IO error. This is the on-demand counterpart to the deliberately
    /// count-free <see cref="GetDatasetsInfo"/>: the preview path calls it so each file is counted only when
    /// the user actually asks for it.</summary>
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
            PersistCacheIfDirty();
            return (true, count, null);
        }
        catch (Exception ex)
        {
            return (false, null, ex.Message);
        }
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
        string key = entry.WildcardName.ToLowerFast();
        if (Cache.TryGetValue(key, out CacheEntry cached) && cached.Hash == entry.FileHash
            && cached.Preview is not null && cached.Preview.Limit == limit)
        {
            return (true, cached.Preview.Columns, cached.Preview.Rows, null);
        }
        try
        {
            (List<string> columns, List<List<string>> rows) = Backend.GetSampleRows(entry.Path, limit);
            StorePreview(key, entry.FileHash, new PreviewData(limit, columns, rows));
            PersistCacheIfDirty();
            return (true, columns, rows, null);
        }
        catch (Exception ex)
        {
            return (false, null, null, ex.Message);
        }
    }

    /// <summary>Proactively computes and caches the schema, usable row count, and preview sample for every
    /// dataset whose results aren't already cached for its current file hash, fanning the work out across a
    /// small pool of independent DuckDB connections. Datasets already fully cached (unchanged files) are
    /// skipped — so a warm after the first is cheap. Persists the cache once at the end. Returns the number of
    /// datasets warmed this call. Used by Refresh so subsequent previews/counts are instant.</summary>
    public static int WarmAll()
    {
        if (!IsActive)
        {
            return 0;
        }
        List<DatasetEntry> pending = [.. Datasets.Values.Where(entry => !IsFullyCached(entry, DefaultPreviewLimit))];
        if (pending.Count == 0)
        {
            return 0;
        }
        // Each DuckDB query already parallelizes across cores, so we keep the number of concurrent
        // connections modest to avoid oversubscription; the win here is hiding per-file I/O latency across
        // many (often small) datasets, not stacking CPU-bound scans.
        int parallelism = Math.Clamp(Environment.ProcessorCount / 2, 2, 6);
        List<Action<IDatasetReader>> jobs = [];
        foreach (DatasetEntry entry in pending)
        {
            DatasetEntry captured = entry;
            jobs.Add(reader => WarmOne(reader, captured, DefaultPreviewLimit));
        }
        Backend.RunPooled(jobs, parallelism);
        PersistCacheIfDirty();
        Logs.Info($"Quarry: warmed {pending.Count} dataset(s).");
        return pending.Count;
    }

    /// <summary>True when the cache already holds this file's schema, usable row count (for the column that
    /// would be resolved now), and a preview at <paramref name="limit"/>, all under its current hash.</summary>
    private static bool IsFullyCached(DatasetEntry entry, int limit)
    {
        if (!Cache.TryGetValue(entry.WildcardName.ToLowerFast(), out CacheEntry cached) || cached.Hash != entry.FileHash)
        {
            return false;
        }
        if (cached.Schema is null || !cached.HasRowCount || cached.Preview is null || cached.Preview.Limit != limit)
        {
            return false;
        }
        // The cached count is tied to a prompt column; if the resolved column changed (config edit), it's stale.
        string resolved = PromptColumnResolver.Resolve(GetConfiguredPromptColumn(entry.WildcardName), cached.Schema) ?? "";
        return cached.RowCountColumn == resolved;
    }

    /// <summary>Warms one dataset on a pooled connection: schema → resolved prompt column → usable count →
    /// preview, storing each into the cache. Best-effort — an unreadable dataset is logged and skipped so it
    /// never faults the warm run (the interactive path will surface its error later).</summary>
    private static void WarmOne(IDatasetReader reader, DatasetEntry entry, int limit)
    {
        string key = entry.WildcardName.ToLowerFast();
        try
        {
            ColumnSchema schema = reader.GetSchema(entry.Path);
            StoreSchema(key, entry.FileHash, schema);
            string resolved = PromptColumnResolver.Resolve(GetConfiguredPromptColumn(entry.WildcardName), schema) ?? "";
            SqlFilter filter = string.IsNullOrEmpty(resolved)
                ? SqlFilter.None
                : SqlFilterBuilder.NonEmptyPrompt(resolved);
            long count = reader.CountRows(entry.Path, filter);
            StoreRowCount(key, entry.FileHash, resolved, count);
            (List<string> columns, List<List<string>> rows) = reader.GetSampleRows(entry.Path, limit);
            StorePreview(key, entry.FileHash, new PreviewData(limit, columns, rows));
        }
        catch (Exception ex)
        {
            Logs.Debug($"Quarry: warm failed for '{entry.WildcardName}': {ex.Message}");
        }
    }

    /// <summary>Scans the datasets folder and rebuilds the name → dataset map. Drops datasets no longer present,
    /// invalidates changed schemas/row counts, and resets the DuckDB connection when anything changed. Writes
    /// nothing to disk — Quarry no longer mirrors datasets into the Wildcards folder.</summary>
    public static void Sync()
    {
        if (!IsActive)
        {
            // Keep the file-backed Cache intact (entries are keyed by file hash and only discarded when that
            // changes), so re-enabling Quarry doesn't have to recompute counts/previews. Just stop serving.
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
                    Logs.Warning($"Quarry: multiple files map to '{name}'; keeping the first, ignoring '{relative}'.");
                    continue;
                }
                string hash = ComputeHash(datasetPath);
                // The cache entry holds this file's schema, row count, and preview together, all keyed by its
                // hash. If the file changed, drop the whole entry so each is recomputed from the new file.
                if (Cache.TryGetValue(key, out CacheEntry cachedEntry) && cachedEntry.Hash != hash)
                {
                    Cache.TryRemove(key, out _);
                    _cacheDirty = true;
                }
                if (!Datasets.TryGetValue(key, out DatasetEntry previous) || previous.FileHash != hash)
                {
                    contentChanged = true;
                }
                Datasets[key] = new DatasetEntry(name, datasetPath, hash);
            }
            foreach (string key in Datasets.Keys.Where(k => !seen.Contains(k)).ToList())
            {
                Datasets.TryRemove(key, out _);
                if (Cache.TryRemove(key, out _))
                {
                    _cacheDirty = true;
                }
                contentChanged = true;
            }
            // A dataset's files changed on disk, so drop the DuckDB connection's cached metadata (notably
            // stale Lance manifests pointing at regenerated, now-missing fragment files). No-op when the
            // backend was never used (e.g. at startup, before the first query).
            if (contentChanged)
            {
                _backend?.Reset();
            }
            // Persist any cache pruning (changed/removed files) done above.
            PersistCacheIfDirty();
            Logs.Info($"Quarry: synced {Datasets.Count} dataset(s).");
        }
        catch (Exception ex)
        {
            Logs.Error($"Quarry: error syncing datasets: {ex.ReadableString()}");
        }
    }

    /// <summary>Removes the placeholder <c>.txt</c> files an older Quarry mirrored into the Wildcards folder.
    /// Deletes only files whose contents are byte-for-byte our <see cref="PlaceholderContent"/> sentinel, so a
    /// real wildcard a user wrote is never touched. Best-effort and idempotent: once the files are gone, later
    /// runs find nothing to do.</summary>
    private static void CleanupLegacyPlaceholders()
    {
        try
        {
            string wildcardDir = WildcardsHelper.Folder;
            if (!Directory.Exists(wildcardDir))
            {
                return;
            }
            long sentinelLength = Encoding.UTF8.GetByteCount(PlaceholderContent);
            int removed = 0;
            foreach (string file in Directory.EnumerateFiles(wildcardDir, "*.txt", SearchOption.AllDirectories))
            {
                try
                {
                    // Cheap guard: skip anything that isn't the exact size of our sentinel before reading it.
                    if (new FileInfo(file).Length != sentinelLength || File.ReadAllText(file) != PlaceholderContent)
                    {
                        continue;
                    }
                    File.Delete(file);
                    removed++;
                }
                catch
                {
                    // A single unreadable/locked file must not abort the sweep.
                }
            }
            if (removed > 0)
            {
                Logs.Info($"Quarry: removed {removed} legacy placeholder wildcard file(s) from '{wildcardDir}'.");
            }
        }
        catch (Exception ex)
        {
            Logs.Warning($"Quarry: failed to clean up legacy placeholders: {ex.Message}");
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

    #region Persistent cache
    /// <summary>One file's cached, hash-keyed results: its schema, the usable row count for a given prompt
    /// column, and a preview sample. Any subset may be present (filled in lazily as each is first needed); the
    /// whole entry is invalidated together when the file's <see cref="DatasetEntry.FileHash"/> changes.</summary>
    private sealed record CacheEntry
    {
        public required string Hash { get; init; }
        public ColumnSchema Schema { get; init; }
        public bool HasRowCount { get; init; }
        public string RowCountColumn { get; init; }
        public long RowCount { get; init; }
        public PreviewData Preview { get; init; }
    }

    /// <summary>A cached preview: the first <see cref="Limit"/> rows of a file (column names + stringified
    /// cells), exactly as the preview UI shows them.</summary>
    private sealed record PreviewData(int Limit, List<string> Columns, List<List<string>> Rows);

    /// <summary>The cache file path, next to the settings file under the SwarmUI data dir (outside this
    /// extension's git repo, so it is never committed). Holds only derived data — safe to delete anytime.</summary>
    private static string CacheFilePath => $"{Program.DataDir}/Quarry.Cache.json";

    private static void StoreSchema(string key, string hash, ColumnSchema schema)
    {
        lock (CacheLock)
        {
            Cache[key] = BaseFor(key, hash) with { Schema = schema };
            _cacheDirty = true;
        }
    }

    private static void StoreRowCount(string key, string hash, string promptColumn, long count)
    {
        lock (CacheLock)
        {
            Cache[key] = BaseFor(key, hash) with { HasRowCount = true, RowCountColumn = promptColumn, RowCount = count };
            _cacheDirty = true;
        }
    }

    private static void StorePreview(string key, string hash, PreviewData preview)
    {
        lock (CacheLock)
        {
            Cache[key] = BaseFor(key, hash) with { Preview = preview };
            _cacheDirty = true;
        }
    }

    /// <summary>The existing entry to update when its hash still matches, or a fresh one (dropping any
    /// now-stale schema/count/preview) when the file has changed. Caller must hold <see cref="CacheLock"/>.</summary>
    private static CacheEntry BaseFor(string key, string hash) =>
        Cache.TryGetValue(key, out CacheEntry existing) && existing.Hash == hash
            ? existing
            : new CacheEntry { Hash = hash };

    private static void PersistCacheIfDirty()
    {
        lock (CacheLock)
        {
            if (!_cacheDirty)
            {
                return;
            }
            try
            {
                SaveCache();
                _cacheDirty = false;
            }
            catch (Exception ex)
            {
                Logs.Warning($"Quarry: failed to persist dataset cache: {ex.Message}");
            }
        }
    }

    /// <summary>Writes the whole cache to disk via a temp file + atomic move. Caller holds <see cref="CacheLock"/>.</summary>
    private static void SaveCache()
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
        JObject root = new() { ["version"] = CacheVersion, ["datasets"] = datasets };
        string directory = Path.GetDirectoryName(CacheFilePath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }
        string temp = $"{CacheFilePath}.tmp";
        File.WriteAllText(temp, root.ToString());
        File.Move(temp, CacheFilePath, overwrite: true);
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

    /// <summary>Loads the persisted cache into memory. Best-effort: a missing, unreadable, or wrong-version
    /// file just leaves the cache empty (everything is recomputed on demand). Stored hashes are re-validated
    /// against the live files during <see cref="Sync"/>, so a stale entry can never be served.</summary>
    private static void LoadCache()
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
    #endregion
}

/// <summary>Settings-UI view of one dataset: its columns, the resolved prompt column (what would be used
/// now), the explicitly configured column (if any), the count of rows with a non-empty prompt — i.e. usable
/// picks (null when unknown), and an error message if the schema couldn't be read.</summary>
public sealed record DatasetInfo(
    string Name,
    IReadOnlyList<ColumnInfo> Columns,
    string ResolvedPromptColumn,
    string ConfiguredPromptColumn,
    IReadOnlyList<string> ConfiguredTagColumns,
    long? RowCount,
    string Error);
