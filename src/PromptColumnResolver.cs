namespace Quarry;

public static class PromptColumnResolver
{
    private static readonly string[] PreferredNames = ["prompt", "text", "caption", "description", "value"];

    public static string Resolve(string configuredColumn, ColumnSchema schema)
        => Resolve(null, configuredColumn, schema);

    public static IReadOnlyList<string> ResolveOutputColumns(IReadOnlyList<string> requestedColumns, string configuredColumn, ColumnSchema schema)
    {
        if (requestedColumns.Count <= 1)
        {
            string resolved = Resolve(requestedColumns.FirstOrDefault(), configuredColumn, schema);
            return resolved is null ? [] : [resolved];
        }
        List<string> columns = [];
        foreach (string name in requestedColumns)
        {
            if (schema.TryGet(name, out ColumnInfo column))
            {
                columns.Add(column.Name);
            }
        }
        return columns;
    }

    /// Resolves the prompt column for one dataset. A tag-level <paramref name="requestedColumn"/> wins when it
    /// exists in this dataset's schema; otherwise it is ignored and resolution falls back to the dataset's
    /// configured column, then a preferred name, then the first column. Because the requested column is checked
    /// per-schema, a column present in one dataset but absent in another resolves independently for each.
    public static string Resolve(string requestedColumn, string configuredColumn, ColumnSchema schema)
    {
        if (!string.IsNullOrWhiteSpace(requestedColumn) && schema.TryGet(requestedColumn, out ColumnInfo requested))
        {
            return requested.Name;
        }
        if (!string.IsNullOrWhiteSpace(configuredColumn) && schema.TryGet(configuredColumn, out ColumnInfo configured))
        {
            return configured.Name;
        }
        foreach (string preferred in PreferredNames)
        {
            if (schema.TryGet(preferred, out ColumnInfo match))
            {
                return match.Name;
            }
        }
        return schema.Columns.Count > 0 ? schema.Columns[0].Name : null;
    }
}
