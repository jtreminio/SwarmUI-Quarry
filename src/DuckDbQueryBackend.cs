using DuckDB.NET.Data;

namespace Quarry;

/// <summary>DuckDB-backed implementation of <see cref="IWildcardQueryBackend"/>. Reads any DuckDB-supported
/// dataset (CSV/JSON/JSONL/Parquet natively, Lance via the <c>lance</c> extension) chosen by
/// <see cref="DatasetSource"/>. Keeps one in-memory DuckDB connection alive, lazily loading the lance
/// extension the first time a <c>.lance</c> dataset is queried. All access is serialized by a lock
/// (a single DuckDB connection is not safe for concurrent commands); v1 favors correctness over throughput.</summary>
public sealed class DuckDbQueryBackend : IWildcardQueryBackend, IDisposable
{
    private DuckDBConnection _connection;
    private readonly object _lock = new();
    private bool _lanceLoaded;

    public DuckDbQueryBackend()
    {
        OpenConnection();
    }

    private void OpenConnection()
    {
        _connection = new DuckDBConnection("DataSource=:memory:");
        _connection.Open();
        // Keep row order deterministic so LIMIT/OFFSET selection is reproducible for a given dataset.
        Execute("SET preserve_insertion_order = true;");
        _lanceLoaded = false;
    }

    /// <summary>Disposes and rebuilds the connection, dropping all cached dataset metadata. This is the
    /// in-process equivalent of restarting: the Lance reader caches a dataset's manifest (its list of
    /// <c>data/&lt;uuid&gt;.lance</c> fragment files) for the life of the connection, so after a dataset is
    /// deleted and regenerated on disk the old connection keeps trying to read the now-missing fragments
    /// ("Failed to read next Lance RecordBatch ... not found"). Callers invoke this when the on-disk
    /// datasets change. Serialized with queries via the same lock, so it is safe while others may be
    /// querying — the in-flight query finishes on the old connection before it is torn down.</summary>
    public void Reset()
    {
        lock (_lock)
        {
            _connection.Dispose();
            OpenConnection();
        }
    }

    public ColumnSchema GetSchema(string datasetPath)
    {
        lock (_lock)
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
    }

    public long CountRows(string datasetPath, SqlFilter filter)
    {
        lock (_lock)
        {
            DatasetSource source = PrepareSource(datasetPath);
            using DuckDBCommand cmd = _connection.CreateCommand();
            cmd.CommandText = $"SELECT count(*) FROM {source.FromExpression}{Where(filter)};";
            Bind(cmd, filter);
            return Convert.ToInt64(cmd.ExecuteScalar());
        }
    }

    public string GetPromptAt(string datasetPath, string promptColumn, SqlFilter filter, long index)
    {
        lock (_lock)
        {
            DatasetSource source = PrepareSource(datasetPath);
            using DuckDBCommand cmd = _connection.CreateCommand();
            cmd.CommandText =
                $"SELECT {QuoteIdentifier(promptColumn)} FROM {source.FromExpression}{Where(filter)} LIMIT 1 OFFSET {index};";
            Bind(cmd, filter);
            object result = cmd.ExecuteScalar();
            return result is null or DBNull ? "" : result.ToString();
        }
    }

    /// <summary>Reads the first <paramref name="limit"/> rows of a dataset (all columns) for the preview UI.
    /// Returns the column names in dataset order and one stringified value per cell (nulls become empty
    /// strings, lists/arrays render as <c>[a, b, c]</c>). <paramref name="limit"/> must be a non-negative
    /// integer; callers are responsible for clamping it to a sane ceiling.</summary>
    public (List<string> Columns, List<List<string>> Rows) GetSampleRows(string datasetPath, int limit)
    {
        lock (_lock)
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

    private void Execute(string sql)
    {
        using DuckDBCommand cmd = _connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    /// <summary>Double-quotes a SQL identifier (column name), escaping embedded quotes by doubling.</summary>
    private static string QuoteIdentifier(string identifier) => $"\"{identifier.Replace("\"", "\"\"")}\"";

    public void Dispose()
    {
        _connection.Dispose();
    }
}
