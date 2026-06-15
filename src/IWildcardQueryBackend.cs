namespace Quarry;

// Reads a tabular dataset (Lance, or any path DuckDB can scan) to back a wildcard, isolating the query
// engine from the handler so it can be swapped or mocked.
public interface IWildcardQueryBackend
{
    ColumnSchema GetSchema(string datasetPath);

    long CountRows(string datasetPath, SqlFilter filter);

    string GetPromptAt(string datasetPath, string promptColumn, SqlFilter filter, long index);

    // Seeks the unfiltered row at index and reports whether it matches; the filter is a projected
    // expression (not a WHERE clause) so the seek stays a native O(1) pushdown for rejection sampling.
    (string Value, bool Matches) GetCandidateAt(string datasetPath, string promptColumn, SqlFilter filter, long index);
}
