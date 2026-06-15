namespace Quarry;

// Keeps the configured tag columns that exist (any casing), in order, deduped to canonical casing.
public static class TagColumnResolver
{
    // When nothing resolves, falls back to fallbackColumn (typically the prompt column) so `tags` still
    // searches something on datasets that were never set up.
    public static List<ColumnInfo> Resolve(IReadOnlyList<string> configured, ColumnSchema schema, string fallbackColumn = null)
    {
        List<ColumnInfo> result = [];
        HashSet<string> seen = new(StringComparer.OrdinalIgnoreCase);
        if (configured is not null)
        {
            foreach (string name in configured)
            {
                if (!string.IsNullOrWhiteSpace(name) && schema.TryGet(name, out ColumnInfo column) && seen.Add(column.Name))
                {
                    result.Add(column);
                }
            }
        }
        if (result.Count == 0 && !string.IsNullOrWhiteSpace(fallbackColumn) && schema.TryGet(fallbackColumn, out ColumnInfo fallback))
        {
            result.Add(fallback);
        }
        return result;
    }
}
