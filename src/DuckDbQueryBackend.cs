using DuckDB.NET.Data;

namespace Quarry;

/// <summary>DuckDB-backed implementation of <see cref="IWildcardQueryBackend"/>. Reads any DuckDB-supported
/// dataset (CSV/JSON/JSONL/Parquet natively, Lance via the <c>lance</c> extension) chosen by
/// <see cref="DatasetSource"/>. A single long-lived <see cref="Conn"/> serves all interactive previews and
/// wildcard generation, serialized by a lock (a single DuckDB connection is not safe for concurrent
/// commands). Bulk cache warming instead fans out over a short-lived pool of independent connections via
/// <see cref="RunPooled"/>, which never touches the shared connection. v1 favors correctness over throughput
/// on the shared path.</summary>
public sealed class DuckDbQueryBackend : IWildcardQueryBackend, IDisposable
{
    /// <summary>One DuckDB connection plus its own lazily-loaded <c>lance</c> flag and the queries that run
    /// on it. NOT thread-safe: every <see cref="Conn"/> is driven by exactly one thread at a time — the
    /// shared instance under the backend lock, a pooled instance by its owning warm worker.</summary>
    private sealed class Conn : IDatasetReader, IDisposable
    {
        private DuckDBConnection _connection;
        private bool _lanceLoaded;

        public Conn() => Open();

        private void Open()
        {
            _connection = new DuckDBConnection("DataSource=:memory:");
            _connection.Open();
            // Keep row order deterministic so LIMIT/OFFSET selection is reproducible for a given dataset.
            Execute("SET preserve_insertion_order = true;");
            _lanceLoaded = false;
        }

        /// <summary>Disposes and rebuilds the connection, dropping all cached dataset metadata (notably stale
        /// Lance manifests pointing at regenerated, now-missing fragment files).</summary>
        public void Reset()
        {
            _connection.Dispose();
            Open();
        }

        public ColumnSchema GetSchema(string datasetPath)
        {
            DatasetSource source = PrepareSource(datasetPath);
            using DuckDBCommand cmd = _connection.CreateCommand();
            cmd.CommandText = $"DESCRIBE SELECT * FROM {source.FromExpression};";
            using DuckDBDataReader reader = cmd.ExecuteReader();
            int nameOrdinal = reader.GetOrdinal("column_name");
            int typeOrdinal = reader.GetOrdinal("column_type");
            List<ColumnInfo> columns = [];
            while (reader.Read())
            {
                string name = reader.GetString(nameOrdinal);
                string type = reader.GetString(typeOrdinal);
                columns.Add(new ColumnInfo(name, DuckDbTypeMapper.MapKind(type)));
            }
            return new ColumnSchema(columns);
        }

        public long CountRows(string datasetPath, SqlFilter filter)
        {
            DatasetSource source = PrepareSource(datasetPath);
            using DuckDBCommand cmd = _connection.CreateCommand();
            cmd.CommandText = $"SELECT count(*) FROM {source.FromExpression}{Where(filter)};";
            Bind(cmd, filter);
            return Convert.ToInt64(cmd.ExecuteScalar());
        }

        public string GetPromptAt(string datasetPath, string promptColumn, SqlFilter filter, long index)
        {
            DatasetSource source = PrepareSource(datasetPath);
            using DuckDBCommand cmd = _connection.CreateCommand();
            cmd.CommandText =
                $"SELECT {QuoteIdentifier(promptColumn)} FROM {source.FromExpression}{Where(filter)} LIMIT 1 OFFSET {index};";
            Bind(cmd, filter);
            object result = cmd.ExecuteScalar();
            return result is null or DBNull ? "" : result.ToString();
        }

        public (List<string> Columns, List<List<string>> Rows) GetSampleRows(string datasetPath, int limit)
        {
            DatasetSource source = PrepareSource(datasetPath);
            using DuckDBCommand cmd = _connection.CreateCommand();
            cmd.CommandText = $"SELECT * FROM {source.FromExpression} LIMIT {Math.Max(0, limit)};";
            using DuckDBDataReader reader = cmd.ExecuteReader();
            List<string> columns = [];
            for (int i = 0; i < reader.FieldCount; i++)
            {
                columns.Add(reader.GetName(i));
            }
            List<List<string>> rows = [];
            while (reader.Read())
            {
                List<string> row = new(columns.Count);
                for (int i = 0; i < columns.Count; i++)
                {
                    row.Add(Stringify(reader.GetValue(i)));
                }
                rows.Add(row);
            }
            return (columns, rows);
        }

        private DatasetSource PrepareSource(string datasetPath)
        {
            DatasetSource source = DatasetSource.Resolve(datasetPath);
            if (source.RequiresLance)
            {
                EnsureLanceLoaded();
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

        /// <summary>Installs and loads the <c>lance</c> core extension on this connection. The first install
        /// downloads a ~235 MB signed binary from extensions.duckdb.org and caches it under ~/.duckdb; later
        /// connections (and process restarts) load it from that cache. No <c>FROM community</c>: <c>lance</c>
        /// is a core extension for this DuckDB build, and the community repo has no build for it (a 404).</summary>
        public void InstallLance()
        {
            Execute("INSTALL lance; LOAD lance;");
            _lanceLoaded = true;
        }

        /// <summary>True when the <c>lance</c> extension is installed (cached on disk) or already loaded. Reads
        /// DuckDB's extension catalog — it neither downloads nor loads the extension — so it is a cheap,
        /// side-effect-free probe. Returns false when lance is unknown to this build or the catalog has no row.</summary>
        public bool IsLanceInstalled()
        {
            using DuckDBCommand cmd = _connection.CreateCommand();
            cmd.CommandText = "SELECT (installed OR loaded) FROM duckdb_extensions() WHERE extension_name = 'lance';";
            object result = cmd.ExecuteScalar();
            return result is bool installed && installed;
        }

        private void Execute(string sql)
        {
            using DuckDBCommand cmd = _connection.CreateCommand();
            cmd.CommandText = sql;
            cmd.ExecuteNonQuery();
        }

        public void Dispose() => _connection.Dispose();
    }

    /// <summary>The single connection backing all interactive previews and wildcard generation.</summary>
    private readonly Conn _shared = new();

    /// <summary>Serializes commands on <see cref="_shared"/> (a single DuckDB connection is not safe for
    /// concurrent commands). The warm pool does not take this lock — it uses its own connections.</summary>
    private readonly object _lock = new();

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

    public string GetPromptAt(string datasetPath, string promptColumn, SqlFilter filter, long index)
    {
        lock (_lock)
        {
            return _shared.GetPromptAt(datasetPath, promptColumn, filter, index);
        }
    }

    /// <summary>Reads the first <paramref name="limit"/> rows of a dataset (all columns) for the preview UI.
    /// See <see cref="Conn.GetSampleRows"/>. <paramref name="limit"/> must be non-negative; callers clamp it.</summary>
    public (List<string> Columns, List<List<string>> Rows) GetSampleRows(string datasetPath, int limit)
    {
        lock (_lock)
        {
            return _shared.GetSampleRows(datasetPath, limit);
        }
    }

    /// <summary>Installs Quarry's <c>lance</c> requirement on a throwaway connection, so the slow first-run
    /// download (~235 MB) never holds the shared lock that interactive queries serialize on. Once it is cached
    /// on disk, the shared connection's lazy <see cref="Conn.EnsureLanceLoaded"/> finds it (a fast no-op +
    /// load). Blocking — call it off the request thread. Throws on failure (offline, unsupported platform).</summary>
    public void InstallLance()
    {
        using Conn temp = new();
        temp.InstallLance();
    }

    /// <summary>True when the DuckDB <c>lance</c> extension is installed or loaded — a cheap catalog probe on
    /// the shared connection (no download, no scan). See <see cref="Conn.IsLanceInstalled"/>.</summary>
    public bool IsLanceInstalled()
    {
        lock (_lock)
        {
            return _shared.IsLanceInstalled();
        }
    }

    /// <summary>Rebuilds the shared connection, dropping its cached dataset metadata. Callers invoke this when
    /// the on-disk datasets change (regenerated Lance fragments etc.). Serialized with shared-connection
    /// queries via the lock. The warm pool's connections are short-lived, so there is nothing else to reset.</summary>
    public void Reset()
    {
        lock (_lock)
        {
            _shared.Reset();
        }
    }

    /// <summary>Runs read-only <paramref name="jobs"/> across up to <paramref name="maxParallelism"/>
    /// short-lived, independent DuckDB connections (one per worker thread, pulling jobs off a shared queue).
    /// Each job is handed an <see cref="IDatasetReader"/> bound to a single connection and is only ever called
    /// on that worker's thread, so the per-connection "one command at a time" rule holds; DuckDB itself allows
    /// concurrent read-only connections. Used for bulk cache warming. Connections are created on entry and
    /// disposed on exit — there is no long-lived pool to keep in sync with <see cref="Reset"/>, and the shared
    /// interactive connection is never touched, so previews/generation run in parallel with a warm. Blocks
    /// until every job has completed. A job that throws is its own responsibility to handle; an unhandled
    /// throw faults the run.</summary>
    public void RunPooled(IReadOnlyList<Action<IDatasetReader>> jobs, int maxParallelism)
    {
        if (jobs is null || jobs.Count == 0)
        {
            return;
        }
        int workers = Math.Clamp(maxParallelism, 1, jobs.Count);
        ConcurrentQueue<Action<IDatasetReader>> queue = new(jobs);
        Task[] tasks = new Task[workers];
        for (int i = 0; i < workers; i++)
        {
            tasks[i] = Task.Run(() =>
            {
                using Conn conn = new();
                while (queue.TryDequeue(out Action<IDatasetReader> job))
                {
                    job(conn);
                }
            });
        }
        Task.WaitAll(tasks);
    }

    /// <summary>Renders a DuckDB cell value as a display string: null/DBNull → "", a list/array →
    /// <c>[a, b, c]</c> (recursing one level via ToString on each item), everything else → ToString.</summary>
    private static string Stringify(object value)
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
                parts.Add(item is null or DBNull ? "" : item.ToString());
            }
            return $"[{string.Join(", ", parts)}]";
        }
        return value.ToString();
    }

    private static string Where(SqlFilter filter) => filter.IsEmpty ? "" : $" WHERE {filter.WhereClause}";

    private static void Bind(DuckDBCommand cmd, SqlFilter filter)
    {
        foreach (QueryParameter parameter in filter.Parameters)
        {
            cmd.Parameters.Add(new DuckDBParameter(parameter.Name, parameter.Value));
        }
    }

    /// <summary>Double-quotes a SQL identifier (column name), escaping embedded quotes by doubling.</summary>
    private static string QuoteIdentifier(string identifier) => $"\"{identifier.Replace("\"", "\"\"")}\"";

    public void Dispose()
    {
        lock (_lock)
        {
            _shared.Dispose();
        }
    }
}
