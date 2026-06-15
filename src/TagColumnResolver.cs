namespace Quarry;

public static class TagColumnResolver
{
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
