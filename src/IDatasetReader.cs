namespace Quarry;

// Read-only dataset access bound to one DuckDB connection used by a single thread, respecting the
// per-connection "one command at a time" rule that cache-warming relies on.
public interface IDatasetReader
{
    ColumnSchema GetSchema(string datasetPath);

    long CountRows(string datasetPath, SqlFilter filter);

    (List<string> Columns, List<List<string>> Rows) GetSampleRows(string datasetPath, int limit);
}
