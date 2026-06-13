namespace Quarry;

/// <summary>Reads a tabular dataset (a Lance dataset, or any path DuckDB can scan) to back a wildcard.
/// Isolates the storage/query engine from the wildcard handler so the engine can be swapped or mocked.</summary>
public interface IWildcardQueryBackend
{
    /// <summary>Introspects the dataset's columns and whether each is scalar or list-typed.</summary>
    ColumnSchema GetSchema(string datasetPath);

    /// <summary>Counts the rows matching <paramref name="filter"/> (all rows when the filter is empty).</summary>
    long CountRows(string datasetPath, SqlFilter filter);

    /// <summary>Returns the <paramref name="promptColumn"/> value of the matching row at the given
    /// zero-based <paramref name="index"/> in stable order. Returns "" if the cell is null or out of range.</summary>
    string GetPromptAt(string datasetPath, string promptColumn, SqlFilter filter, long index);
}
