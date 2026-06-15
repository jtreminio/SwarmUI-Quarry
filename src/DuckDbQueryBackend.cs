using System.IO;
using DuckDB.NET.Data;
using SwarmUI.Utils;

namespace Quarry;

public sealed class DuckDbQueryBackend : IWildcardQueryBackend, IDisposable
{
    private sealed class Conn : IDatasetReader, IDisposable
    {
        private DuckDBConnection _connection;
        private bool _lanceLoaded;

        public Conn() => Open();

        private void Open()
        {
            _connection = new DuckDBConnection("DataSource=:memory:");
            _connection.Open();
            Execute("SET preserve_insertion_order = true;");
            string extensionDirectory = ResolveExtensionDirectory();
            if (extensionDirectory is not null)
            {
                Execute($"SET extension_directory = '{extensionDirectory.Replace("'", "''")}';");
            }
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
                $"SELECT {SqlText.QuoteIdentifier(promptColumn)} FROM {source.FromExpression}{Where(filter)} LIMIT 1 OFFSET {index};";
            Bind(cmd, filter);
            object result = cmd.ExecuteScalar();
            return result is null or DBNull ? "" : result.ToString();
        }

        public (string Value, bool Matches) GetCandidateAt(string datasetPath, string promptColumn, SqlFilter filter, long index)
        {
            DatasetSource source = PrepareSource(datasetPath);
            using DuckDBCommand cmd = _connection.CreateCommand();
            string matchExpr = filter.IsEmpty ? "TRUE" : $"({filter.WhereClause})";
            cmd.CommandText =
                $"SELECT {SqlText.QuoteIdentifier(promptColumn)}, {matchExpr} FROM {source.FromExpression} LIMIT 1 OFFSET {index};";
            Bind(cmd, filter);
            using DuckDBDataReader reader = cmd.ExecuteReader();
            if (!reader.Read())
            {
                return ("", false);
            }
            string value = reader.IsDBNull(0) ? "" : reader.GetValue(0)?.ToString() ?? "";
            bool matches = !reader.IsDBNull(1) && Convert.ToBoolean(reader.GetValue(1));
            return (value, matches);
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

        private void Execute(string sql)
        {
            using DuckDBCommand cmd = _connection.CreateCommand();
            cmd.CommandText = sql;
            cmd.ExecuteNonQuery();
        }

        public void Dispose() => _connection.Dispose();
    }

    private readonly Conn _shared = new();
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

    public (string Value, bool Matches) GetCandidateAt(string datasetPath, string promptColumn, SqlFilter filter, long index)
    {
        lock (_lock)
        {
            return _shared.GetCandidateAt(datasetPath, promptColumn, filter, index);
        }
    }

    public (List<string> Columns, List<List<string>> Rows) GetSampleRows(string datasetPath, int limit)
    {
        lock (_lock)
        {
            return _shared.GetSampleRows(datasetPath, limit);
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

    public void Dispose()
    {
        lock (_lock)
        {
            _shared.Dispose();
        }
    }
}
