using System.IO;
using DuckDB.NET.Data;
using SwarmUI.Utils;

namespace Quarry;

public sealed class DuckDbQueryBackend : IQueryBackend, IDisposable
{
    private const int ScanThreadsPerConnection = 2;
    private const string ScanMemoryLimit = "2GB";
    private static readonly int MaxConcurrentScanConnections = Math.Clamp(Environment.ProcessorCount / 2, 4, 12);
    private static readonly SemaphoreSlim _scanGate = new(MaxConcurrentScanConnections, MaxConcurrentScanConnections);

    private sealed class Conn : IDatasetReader, IDisposable
    {
        private DuckDBConnection _connection;
        private bool _lanceLoaded;
        private readonly bool _forScan;

        public Conn(bool forScan = false)
        {
            _forScan = forScan;
            Open();
        }

        private void Open()
        {
            DuckDBConnection conn = new("DataSource=:memory:");
            try
            {
                conn.Open();
                if (_forScan)
                {
                    ExecuteOn(conn, "SET preserve_insertion_order = false;");
                    ExecuteOn(conn, $"SET threads = {ScanThreadsPerConnection};");
                    ExecuteOn(conn, $"SET memory_limit = '{ScanMemoryLimit}';");
                }
                else
                {
                    ExecuteOn(conn, "SET preserve_insertion_order = true;");
                }
                string extensionDirectory = ResolveExtensionDirectory();
                if (extensionDirectory is not null)
                {
                    ExecuteOn(conn, $"SET extension_directory = {SqlText.QuoteLiteral(extensionDirectory)};");
                }
            }
            catch
            {
                conn.Dispose();
                throw;
            }
            _connection = conn;
            _lanceLoaded = false;
        }

        private static string ResolveExtensionDirectory()
        {
            try
            {
                string dir = Path.Combine(DatasetManager.CacheFolder, "duckdb");
                Directory.CreateDirectory(dir);
                return dir;
            }
            catch (Exception ex)
            {
                Logs.Warning($"Quarry: could not create the DuckDB extension cache under the extension's .cache folder; falling back to DuckDB's default (~/.duckdb), which may not survive restarts: {ex.Message}");
                return null;
            }
        }

        public void Reset()
        {
            DuckDBConnection old = _connection;
            Open();
            old?.Dispose();
        }

        public ColumnSchema GetSchema(string datasetPath)
        {
            DatasetSource source = PrepareSource(datasetPath);
            List<(string Name, string Type)> described = [];
            using (DuckDBCommand cmd = _connection.CreateCommand())
            {
                cmd.CommandText = $"DESCRIBE SELECT * FROM {source.FromExpression};";
                using DuckDBDataReader reader = cmd.ExecuteReader();
                int nameOrdinal = reader.GetOrdinal("column_name");
                int typeOrdinal = reader.GetOrdinal("column_type");
                while (reader.Read())
                {
                    described.Add((reader.GetString(nameOrdinal), reader.GetString(typeOrdinal)));
                }
            }
            HashSet<string> ngram = source.RequiresLance
                ? GetNgramIndexedColumns(source)
                : new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var layout = CasingStorage.LoadLayout(datasetPath);
            Dictionary<string, string> casing = layout.Columns;
            foreach ((string original, string patch) in casing)
            {
                if (!described.Any(c => c.Name == original && c.Type == "VARCHAR")
                    || !described.Any(c => c.Name == patch && c.Type == "BLOB"))
                {
                    throw new InvalidDataException($"Invalid casing columns for '{original}' in {datasetPath}.");
                }
            }
            HashSet<string> patches = new(casing.Values, StringComparer.OrdinalIgnoreCase);
            HashSet<string> helpers = new(layout.Helpers.Select(h => h.Physical), StringComparer.OrdinalIgnoreCase);
            List<ColumnInfo> columns = [];
            foreach ((string name, string type) in described)
            {
                bool numeric = DuckDbTypeMapper.IsNumeric(type);
                columns.Add(new ColumnInfo(
                    name,
                    DuckDbTypeMapper.MapKind(type),
                    numeric,
                    hasNgramIndex: ngram.Contains(name),
                    numericType: numeric ? type : null,
                    casingColumn: casing.GetValueOrDefault(name), isCasingPatch: patches.Contains(name), dataType: type,
                    isSearchHelper: helpers.Contains(name)));
            }
            List<SearchHelper> usable = [];
            if (layout.CanUseSearchHelpers && !columns.Any(c => c.Name.Equals("_rowid", StringComparison.OrdinalIgnoreCase)))
            {
                foreach (SearchHelper helper in layout.Helpers)
                {
                    ColumnInfo parent = columns.FirstOrDefault(c => c.Name == helper.Column);
                    ColumnInfo physical = columns.FirstOrDefault(c => c.Name == helper.Physical);
                    if (parent is not null && parent.IsRecord
                        && (helper.Kind == "list" ? parent.Kind == ColumnKind.List : parent.Kind == ColumnKind.Object)
                        && parent.Fields.Any(f => f.Name == helper.Field && f.DataType == "VARCHAR")
                        && physical?.DataType == "VARCHAR" && ngram.Contains(helper.Physical))
                    {
                        usable.Add(helper);
                    }
                }
            }
            return new ColumnSchema(columns, usable);
        }

        private HashSet<string> GetNgramIndexedColumns(DatasetSource source)
        {
            HashSet<string> result = new(StringComparer.OrdinalIgnoreCase);
            try
            {
                using DuckDBCommand cmd = _connection.CreateCommand();
                cmd.CommandText = $"SHOW INDEXES ON {source.FromExpression};";
                using DuckDBDataReader reader = cmd.ExecuteReader();
                int typeOrdinal = reader.GetOrdinal("index_type");
                int fieldsOrdinal = reader.GetOrdinal("fields");
                while (reader.Read())
                {
                    string type = reader.IsDBNull(typeOrdinal) ? "" : reader.GetValue(typeOrdinal)?.ToString() ?? "";
                    if (!string.Equals(type, "NGram", StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }
                    string fields = reader.IsDBNull(fieldsOrdinal) ? "" : reader.GetValue(fieldsOrdinal)?.ToString() ?? "";
                    foreach (string field in fields.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                    {
                        result.Add(field.Trim('[', ']', '"', ' '));
                    }
                }
            }
            catch (Exception ex)
            {
                Logs.Debug($"Quarry: SHOW INDEXES failed for {source.FromExpression}: {ex.Message}");
            }
            return result;
        }

        public long CountRows(string datasetPath, SqlFilter filter)
        {
            DatasetSource source = PrepareSource(datasetPath);
            var relation = CandidateSource(datasetPath, source, filter);
            using DuckDBCommand cmd = _connection.CreateCommand();
            cmd.CommandText = $"{relation.Prefix}SELECT count(*) FROM {relation.From}{Where(filter)};";
            Bind(cmd, filter, relation.UsesCandidates);
            return Convert.ToInt64(cmd.ExecuteScalar());
        }

        public List<string> GetPrompts(string datasetPath, IReadOnlyList<string> promptColumns, SqlFilter filter, int limit, long offset)
        {
            if (promptColumns.Count == 0)
            {
                return [];
            }
            DatasetSource source = PrepareSource(datasetPath);
            if (filter.Output is not null)
            {
                return GetNestedPrompts(datasetPath, source, filter, limit, offset);
            }

            using DuckDBCommand cmd = _connection.CreateCommand();
            var layout = CasingStorage.LoadLayout(datasetPath);
            Dictionary<string, string> casing = layout.Columns;
            List<string> projection = OutputProjection(promptColumns, casing, layout.Helpers.Select(h => h.Physical));
            cmd.CommandText =
                $"SELECT {string.Join(", ", projection.Select(SqlText.QuoteIdentifier))} FROM {source.FromExpression}{Where(filter)} LIMIT {Math.Max(0, limit)} OFFSET {offset};";
            Bind(cmd, filter);
            using DuckDBDataReader reader = cmd.ExecuteReader();
            List<string> prompts = [];
            while (reader.Read())
            {
                prompts.Add(ReadPrompt(reader, promptColumns, casing));
            }
            return prompts;
        }

        public (string Value, bool Matches) GetCandidateAt(string datasetPath, IReadOnlyList<string> promptColumns, SqlFilter filter, long index)
        {
            if (promptColumns.Count == 0)
            {
                return ("", false);
            }
            DatasetSource source = PrepareSource(datasetPath);
            if (filter.Output is not null)
            {
                using DuckDBCommand nested = _connection.CreateCommand();
                nested.CommandText = $"WITH __quarry_physical AS MATERIALIZED (SELECT * FROM {source.FromExpression} LIMIT 1 OFFSET {Math.Max(0, index)}) "
                    + $"SELECT {NestedProjection(filter.Output)}, ({filter.WhereClause}) FROM __quarry_physical;";
                Bind(nested, filter);
                using DuckDBDataReader selected = nested.ExecuteReader();
                if (!selected.Read())
                {
                    return ("", false);
                }

                bool nestedMatches = !selected.IsDBNull(selected.FieldCount - 1) && Convert.ToBoolean(selected.GetValue(selected.FieldCount - 1));
                return (nestedMatches ? ReadNested(selected, filter.Output) : "", nestedMatches);
            }
            using DuckDBCommand cmd = _connection.CreateCommand();
            var layout = CasingStorage.LoadLayout(datasetPath);
            Dictionary<string, string> casing = layout.Columns;
            List<string> projection = OutputProjection(promptColumns, casing, layout.Helpers.Select(h => h.Physical));
            string matchExpr = filter.IsEmpty ? "TRUE" : $"({filter.WhereClause})";
            cmd.CommandText =
                $"SELECT {string.Join(", ", projection.Select(SqlText.QuoteIdentifier))}, {matchExpr} FROM {source.FromExpression} LIMIT 1 OFFSET {index};";
            Bind(cmd, filter);
            using DuckDBDataReader reader = cmd.ExecuteReader();
            if (!reader.Read())
            {
                return ("", false);
            }
            string value = ReadPrompt(reader, promptColumns, casing);
            bool matches = !reader.IsDBNull(projection.Count) && Convert.ToBoolean(reader.GetValue(projection.Count));
            return (value, matches);
        }

        private static string NestedProjection(NestedOutput output)
            => string.Join(", ", output.Parts.SelectMany(p => p.CasingColumn is null
                ? new[] { p.Expression } : new[] { p.Expression, SqlText.QuoteIdentifier(p.CasingColumn) }));

        private static (string Prefix, string From, string Order, bool UsesCandidates) CandidateSource(
            string datasetPath, DatasetSource source, SqlFilter filter)
        {
            if (!source.RequiresLance || !filter.RequiresRecordScan)
            {
                return ("", source.FromExpression, "", false);
            }

            var layout = CasingStorage.LoadLayout(datasetPath);
            // A previously compiled filter may outlive an external commit or descriptor change.
            bool candidates = filter.CandidateWhereClause.Length > 0 && layout.CanUseSearchHelpers
                && filter.CandidateHelpers.All(layout.Helpers.Contains);
            string ordinal = SqlText.QuoteIdentifier(filter.CandidateOrderColumn);
            // Materialize scan fallbacks too: the Lance reader's direct projection +
            // list predicate + LIMIT path can produce an invalid selection vector.
            // Window ordinals preserve physical order without assuming stable row IDs.
            string row = candidates ? "_rowid" : "row_number() OVER ()";
            string restriction = candidates ? $" WHERE {filter.CandidateWhereClause}" : "";
            return ($"WITH __quarry_candidates AS MATERIALIZED (SELECT *, {row} AS {ordinal} FROM {source.FromExpression}{restriction}) ",
                "__quarry_candidates", $" ORDER BY {ordinal}", candidates);
        }

        private List<string> GetNestedPrompts(string datasetPath, DatasetSource source, SqlFilter filter, int limit, long offset)
        {
            var relation = CandidateSource(datasetPath, source, filter);
            using DuckDBCommand cmd = _connection.CreateCommand();
            cmd.CommandText = $"{relation.Prefix}SELECT {NestedProjection(filter.Output)} FROM {relation.From}{Where(filter)}{relation.Order} LIMIT {Math.Max(0, limit)} OFFSET {Math.Max(0, offset)};";
            Bind(cmd, filter, relation.UsesCandidates);
            using DuckDBDataReader reader = cmd.ExecuteReader();
            List<string> result = [];
            while (reader.Read())
            {
                result.Add(ReadNested(reader, filter.Output));
            }

            return result;
        }

        private static string ReadNested(DuckDBDataReader reader, NestedOutput output)
        {
            List<string> records = [];
            int ordinal = 0;
            foreach (OutputPart part in output.Parts)
            {
                string value = reader.IsDBNull(ordinal) ? null : reader.GetValue(ordinal).ToString();
                ordinal++;
                if (part.CasingColumn is not null)
                {
                    value = RestoreValue(value, reader.GetValue(ordinal++))?.Trim() ?? "";
                }
                if (string.IsNullOrWhiteSpace(value))
                {
                    continue;
                }

                records.Add(part.Label is null ? value : part.Label + ": " + value);
            }
            return string.Join(output.Format.RecordSeparator, records);
        }

        private static List<string> OutputProjection(IReadOnlyList<string> columns, Dictionary<string, string> casing,
            IEnumerable<string> searchHelpers = null)
        {
            HashSet<string> hidden = new(searchHelpers ?? [], StringComparer.OrdinalIgnoreCase);
            if (columns.Any(c => casing.Values.Contains(c, StringComparer.OrdinalIgnoreCase) || hidden.Contains(c)))
            {
                throw new QueryException("Casing patches and search helpers are internal storage columns.");
            }
            return [.. columns.Concat(columns.Where(casing.ContainsKey).Select(c => casing[c])).Distinct(StringComparer.OrdinalIgnoreCase)];
        }

        private static string ReadPrompt(DuckDBDataReader reader, IReadOnlyList<string> columns, Dictionary<string, string> casing)
        {
            List<string> values = [];
            for (int i = 0; i < columns.Count; i++)
            {
                string value = StringifyPrompt(ReadValue(reader, columns[i], casing)).Trim();
                if (value.Length > 0)
                {
                    values.Add(value);
                }
            }
            return string.Join(", ", values);
        }

        public (List<string> Columns, List<List<string>> Rows) GetSampleRows(string datasetPath, int limit)
        {
            DatasetSource source = PrepareSource(datasetPath);
            using DuckDBCommand cmd = _connection.CreateCommand();
            cmd.CommandText = $"SELECT * FROM {source.FromExpression} LIMIT {Math.Max(0, limit)};";
            using DuckDBDataReader reader = cmd.ExecuteReader();
            var layout = CasingStorage.LoadLayout(datasetPath);
            return Drain(reader, layout.Columns, layout.Helpers.Select(h => h.Physical));
        }

        public void WriteImageHistory(string indexDir, string lancePath, IReadOnlyList<string> stagingJsonPaths, string livePathsJsonPath)
        {
            EnsureLanceLoaded();
            Execute($"ATTACH {SqlText.QuoteLiteral(indexDir)} AS qidx (TYPE lance);");
            try
            {
                string tableRef = $"qidx.main.{ImageHistoryIndex.TableName}";
                if (!Directory.Exists(lancePath))
                {
                    Execute(ImageHistoryIndex.CreateTableSql(tableRef));
                }
                EnsureLowercaseColumns(tableRef);
                if (stagingJsonPaths is not null)
                {
                    foreach (string stagingJsonPath in stagingJsonPaths)
                    {
                        Execute(ImageHistoryIndex.MergeUpsertSql(tableRef, SqlText.QuoteLiteral(stagingJsonPath)));
                    }
                }
                if (livePathsJsonPath is not null)
                {
                    Execute(ImageHistoryIndex.MergePruneSql(tableRef, SqlText.QuoteLiteral(livePathsJsonPath)));
                }
                BuildScalarIndexes(tableRef);
            }
            finally
            {
                try
                {
                    Execute("DETACH qidx;");
                }
                catch (Exception ex)
                {
                    Logs.Warning($"Quarry: failed to detach image-history index: {ex.Message}");
                }
            }
            MaybeCompact(lancePath);
        }

        private static int _writeCount;
        private static int _ngramBuildCount;
        private static bool _maintenanceDisabled;

        private void EnsureLowercaseColumns(string tableRef)
        {
            HashSet<string> existing = new(StringComparer.OrdinalIgnoreCase);
            using (DuckDBCommand cmd = _connection.CreateCommand())
            {
                cmd.CommandText = $"SELECT * FROM {tableRef} LIMIT 0;";
                using DuckDBDataReader reader = cmd.ExecuteReader();
                for (int i = 0; i < reader.FieldCount; i++)
                {
                    existing.Add(reader.GetName(i));
                }
            }
            foreach (string col in ImageHistoryIndex.LowercaseSearchColumns)
            {
                string lc = ImageHistoryIndex.LcColumn(col);
                if (existing.Contains(lc))
                {
                    continue;
                }
                Execute($"ALTER TABLE {tableRef} ADD COLUMN {lc} VARCHAR;");
                Execute($"UPDATE {tableRef} SET {lc} = lower({col});");
            }
        }

        private void BuildScalarIndexes(string tableRef)
        {
            bool refresh = Interlocked.Increment(ref _ngramBuildCount) % 5 == 1;
            foreach ((string drop, string create) in
                ImageHistoryIndex.NgramIndexDdls(tableRef).Concat(ImageHistoryIndex.BtreeIndexDdls(tableRef)))
            {
                if (refresh)
                {
                    try { Execute(drop); } catch { /* index may not exist yet */ }
                }
                try
                {
                    Execute(create);
                }
                catch (Exception ex) when (ex.Message.Contains("already exists", StringComparison.OrdinalIgnoreCase))
                {
                    // Expected on the writes between periodic refreshes -- the index is already there.
                }
                catch (Exception ex)
                {
                    Logs.Debug($"Quarry: image-history scalar index build failed: {ex.Message}");
                }
            }
        }

        private void MaybeCompact(string lancePath)
        {
            if (_maintenanceDisabled || !Directory.Exists(lancePath))
            {
                return;
            }
            int n = Interlocked.Increment(ref _writeCount);
            try
            {
                string target = SqlText.QuoteLiteral(lancePath);
                Execute($"VACUUM LANCE {target} WITH (retain_n_versions = 5, older_than_seconds = 0);");
                if (n % 5 == 0)
                {
                    Execute($"OPTIMIZE {target} WITH (target_rows_per_fragment = 1048576);");
                }
            }
            catch (Exception ex)
            {
                _maintenanceDisabled = true;
                Logs.Warning($"Quarry: Lance index maintenance is unavailable ({ex.Message}); skipping compaction/vacuum for the rest of this session.");
            }
        }

        public Dictionary<string, string> GetPathHashes(string lancePath)
        {
            DatasetSource source = PrepareSource(lancePath);
            using DuckDBCommand cmd = _connection.CreateCommand();
            cmd.CommandText = $"SELECT {SqlText.QuoteIdentifier(ImageHistoryIndex.PathColumn)}, \"file_hash\" FROM {source.FromExpression};";
            using DuckDBDataReader reader = cmd.ExecuteReader();
            Dictionary<string, string> result = new(StringComparer.Ordinal);
            while (reader.Read())
            {
                if (!reader.IsDBNull(0))
                {
                    result[reader.GetString(0)] = reader.IsDBNull(1) ? "" : reader.GetValue(1)?.ToString() ?? "";
                }
            }
            return result;
        }

        public (List<string> Columns, List<List<string>> Rows) GetFilteredRows(string lancePath, IReadOnlyList<string> selectColumns, SqlFilter filter, string sortColumn, bool sortDescending, int limit, int offset)
        {
            DatasetSource source = PrepareSource(lancePath);
            var layout = CasingStorage.LoadLayout(lancePath);
            Dictionary<string, string> casing = layout.Columns;
            IEnumerable<string> helpers = layout.Helpers.Select(h => h.Physical);
            string projection = selectColumns is { Count: > 0 }
                ? string.Join(", ", OutputProjection(selectColumns, casing, helpers).Select(SqlText.QuoteIdentifier))
                : "*";
            string tiebreak = selectColumns is { Count: > 0 }
                && !string.Equals(selectColumns[0], sortColumn, StringComparison.OrdinalIgnoreCase)
                    ? $", {SqlText.QuoteIdentifier(selectColumns[0])} ASC"
                    : "";
            string order = string.IsNullOrEmpty(sortColumn)
                ? ""
                : $" ORDER BY {SqlText.QuoteIdentifier(sortColumn)} {(sortDescending ? "DESC" : "ASC")}{tiebreak}";
            using DuckDBCommand cmd = _connection.CreateCommand();
            cmd.CommandText = $"SELECT {projection} FROM {source.FromExpression}{Where(filter)}{order} LIMIT {Math.Max(0, limit)} OFFSET {Math.Max(0, offset)};";
            Bind(cmd, filter);
            using DuckDBDataReader reader = cmd.ExecuteReader();
            return Drain(reader, casing, helpers);
        }

        public List<string> ListDiscoveredFields(string lancePath, string jsonColumn)
        {
            DatasetSource source = PrepareSource(lancePath);
            string quoted = SqlText.QuoteIdentifier(jsonColumn);
            using DuckDBCommand cmd = _connection.CreateCommand();
            cmd.CommandText = $"SELECT DISTINCT unnest(json_keys({quoted})) AS k FROM {source.FromExpression} WHERE {quoted} IS NOT NULL AND {quoted} != '{{}}' ORDER BY k;";
            using DuckDBDataReader reader = cmd.ExecuteReader();
            List<string> result = [];
            while (reader.Read())
            {
                if (!reader.IsDBNull(0))
                {
                    result.Add(reader.GetString(0));
                }
            }
            return result;
        }

        private DatasetSource PrepareSource(string datasetPath)
        {
            DatasetSource source = DatasetSource.Resolve(datasetPath);
            if (source.RequiresLance)
            {
                EnsureLanceLoaded();
                // Includes count-only and physical-row sampling reads: stale authoritative
                // flat casing patches cannot be safely restored by an exact-scan fallback.
                _ = CasingStorage.LoadLayout(datasetPath);
            }
            return source;
        }

        private void EnsureLanceLoaded()
        {
            if (_lanceLoaded)
            {
                return;
            }
            Execute("INSTALL lance; LOAD lance;");
            _lanceLoaded = true;
        }

        public void InstallLance()
        {
            Execute("INSTALL lance; LOAD lance;");
            _lanceLoaded = true;
        }

        public bool IsLanceInstalled()
        {
            using DuckDBCommand cmd = _connection.CreateCommand();
            cmd.CommandText = "SELECT (installed OR loaded) FROM duckdb_extensions() WHERE extension_name = 'lance';";
            object result = cmd.ExecuteScalar();
            return result is bool installed && installed;
        }

        private void Execute(string sql) => ExecuteOn(_connection, sql);

        private static void ExecuteOn(DuckDBConnection connection, string sql)
        {
            using DuckDBCommand cmd = connection.CreateCommand();
            cmd.CommandText = sql;
            cmd.ExecuteNonQuery();
        }

        public void Dispose() => _connection.Dispose();
    }

    private readonly Conn _shared = new();
    private readonly object _lock = new();
    private readonly object _writeLock = new();
    private readonly ReaderWriterLockSlim _maintenance = new();

    public ColumnSchema GetSchema(string datasetPath)
    {
        lock (_lock)
        {
            return _shared.GetSchema(datasetPath);
        }
    }

    public long CountRows(string datasetPath, SqlFilter filter)
    {
        lock (_lock)
        {
            return _shared.CountRows(datasetPath, filter);
        }
    }

    public string GetPromptAt(string datasetPath, IReadOnlyList<string> promptColumns, SqlFilter filter, long index)
        => GetPrompts(datasetPath, promptColumns, filter, 1, index).FirstOrDefault() ?? "";

    public List<string> GetPrompts(string datasetPath, IReadOnlyList<string> promptColumns, SqlFilter filter, int limit, long offset)
    {
        lock (_lock)
        {
            return _shared.GetPrompts(datasetPath, promptColumns, filter, limit, offset);
        }
    }

    public (string Value, bool Matches) GetCandidateAt(string datasetPath, IReadOnlyList<string> promptColumns, SqlFilter filter, long index)
    {
        lock (_lock)
        {
            return _shared.GetCandidateAt(datasetPath, promptColumns, filter, index);
        }
    }

    public (List<string> Columns, List<List<string>> Rows) GetSampleRows(string datasetPath, int limit)
    {
        lock (_lock)
        {
            return _shared.GetSampleRows(datasetPath, limit);
        }
    }

    public void WriteImageHistory(string indexDir, string lancePath, IReadOnlyList<string> stagingJsonPaths, string livePathsJsonPath)
    {
        lock (_writeLock)
        {
            using Conn writer = new();
            writer.WriteImageHistory(indexDir, lancePath, stagingJsonPaths, livePathsJsonPath);
        }
        lock (_lock)
        {
            _shared.Reset();
        }
    }

    public Dictionary<string, string> GetPathHashes(string lancePath)
    {
        lock (_lock)
        {
            return _shared.GetPathHashes(lancePath);
        }
    }

    public (List<string> Columns, List<List<string>> Rows) GetFilteredRows(string lancePath, IReadOnlyList<string> selectColumns, SqlFilter filter, string sortColumn, bool sortDescending, int limit, int offset)
    {
        lock (_lock)
        {
            return _shared.GetFilteredRows(lancePath, selectColumns, filter, sortColumn, sortDescending, limit, offset);
        }
    }

    public List<string> ListDiscoveredFields(string lancePath, string jsonColumn)
    {
        lock (_lock)
        {
            return _shared.ListDiscoveredFields(lancePath, jsonColumn);
        }
    }

    public void InstallLance()
    {
        using Conn temp = new();
        temp.InstallLance();
    }

    public bool IsLanceInstalled()
    {
        lock (_lock)
        {
            return _shared.IsLanceInstalled();
        }
    }

    public void Reset()
    {
        lock (_lock)
        {
            _shared.Reset();
        }
    }

    public void RunPooled(IReadOnlyList<Action<IDatasetReader>> jobs, int maxParallelism)
    {
        _maintenance.EnterReadLock();
        try
        {
            RunPooledCore(jobs, maxParallelism);
        }
        finally
        {
            _maintenance.ExitReadLock();
        }
    }

    internal T WithMaintenance<T>(Func<T> action)
    {
        _maintenance.EnterWriteLock();
        try
        {
            lock (_lock)
            {
                _shared.Reset();
                try { return action(); }
                finally { _shared.Reset(); }
            }
        }
        finally
        {
            _maintenance.ExitWriteLock();
        }
    }

    private static void RunPooledCore(IReadOnlyList<Action<IDatasetReader>> jobs, int maxParallelism)
    {
        if (jobs is null || jobs.Count == 0)
        {
            return;
        }
        int workers = Math.Clamp(maxParallelism, 1, jobs.Count);
        ConcurrentQueue<Action<IDatasetReader>> queue = new(jobs);
        Task[] tasks = new Task[workers - 1];
        for (int i = 0; i < tasks.Length; i++)
        {
            tasks[i] = Task.Run(() => DrainQueue(queue));
        }
        DrainQueue(queue);
        Task.WaitAll(tasks);
    }

    private static void DrainQueue(ConcurrentQueue<Action<IDatasetReader>> queue)
    {
        if (queue.IsEmpty)
        {
            return;
        }
        _scanGate.Wait();
        try
        {
            using Conn conn = new(forScan: true);
            while (queue.TryDequeue(out Action<IDatasetReader> job))
            {
                job(conn);
            }
        }
        finally
        {
            _scanGate.Release();
        }
    }

    private static object ReadValue(DuckDBDataReader reader, string name, Dictionary<string, string> casing)
    {
        object value = reader.GetValue(reader.GetOrdinal(name));
        if (!casing.TryGetValue(name, out string patch))
        {
            return value;
        }
        return RestoreValue(value is DBNull ? null : (string)value, reader.GetValue(reader.GetOrdinal(patch)));
    }

    private static string RestoreValue(string value, object patchValue)
    {
        byte[] bytes = null;
        if (patchValue is Stream stream)
        {
            using (stream)
            {
                bytes = new byte[checked((int)stream.Length)];
                stream.ReadExactly(bytes);
            }
        }
        else if (patchValue is not DBNull)
        {
            bytes = (byte[])patchValue;
        }
        return CasingStorage.Restore(value, bytes);
    }

    private static (List<string> Columns, List<List<string>> Rows) Drain(DuckDBDataReader reader, Dictionary<string, string> casing,
        IEnumerable<string> searchHelpers = null)
    {
        HashSet<string> hidden = new(searchHelpers ?? [], StringComparer.OrdinalIgnoreCase);
        List<string> columns = [];
        for (int i = 0; i < reader.FieldCount; i++)
        {
            string name = reader.GetName(i);
            if (!casing.Values.Contains(name, StringComparer.OrdinalIgnoreCase) && !hidden.Contains(name))
            {
                columns.Add(name);
            }
        }
        List<List<string>> rows = [];
        while (reader.Read())
        {
            List<string> row = new(columns.Count);
            for (int i = 0; i < columns.Count; i++)
            {
                row.Add(Stringify(ReadValue(reader, columns[i], casing)));
            }
            rows.Add(row);
        }
        return (columns, rows);
    }

    private static string Stringify(object value)
    {
        if (value is null or DBNull)
        {
            return "";
        }
        if (value is System.Collections.IDictionary)
        {
            return System.Text.Json.JsonSerializer.Serialize(value);
        }

        if (value is not string && value is System.Collections.IEnumerable enumerable)
        {
            List<string> parts = [];
            foreach (object item in enumerable)
            {
                parts.Add(item is null or DBNull ? "" : item is System.Collections.IDictionary
                    ? System.Text.Json.JsonSerializer.Serialize(item) : item.ToString());
            }
            return $"[{string.Join(", ", parts)}]";
        }
        return value.ToString();
    }

    private static string StringifyPrompt(object value)
    {
        if (value is null or DBNull)
        {
            return "";
        }
        if (value is not string && value is System.Collections.IEnumerable enumerable)
        {
            List<string> parts = [];
            foreach (object item in enumerable)
            {
                if (item is null or DBNull)
                {
                    continue;
                }
                string text = item.ToString();
                if (text.Length > 0)
                {
                    parts.Add(text);
                }
            }
            return string.Join(", ", parts);
        }
        return value.ToString();
    }

    private static string Where(SqlFilter filter) => filter.IsEmpty ? "" : $" WHERE {filter.WhereClause}";

    private static void Bind(DuckDBCommand cmd, SqlFilter filter, bool includeCandidates = false)
    {
        foreach (QueryParameter parameter in filter.Parameters)
        {
            cmd.Parameters.Add(new DuckDBParameter(parameter.Name, parameter.Value));
        }
        if (includeCandidates)
        {
            foreach (QueryParameter parameter in filter.CandidateParameters)
            {
                cmd.Parameters.Add(new DuckDBParameter(parameter.Name, parameter.Value));
            }
        }
    }

    public void Dispose()
    {
        lock (_lock)
        {
            _shared.Dispose();
        }
    }
}
