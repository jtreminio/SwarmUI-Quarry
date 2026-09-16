namespace Quarry;

public static class ColumnConfig
{
    private static readonly Dictionary<string, string> PromptColumns = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, List<string>> TagColumns = new(StringComparer.OrdinalIgnoreCase);
    private static readonly object Lock = new();

    public static string GetPromptColumn(string name)
    {
        lock (Lock)
        {
            return PromptColumns.TryGetValue(DatasetCatalog.CanonicalName(name), out string column) ? column : null;
        }
    }

    public static void SetPromptColumns(IReadOnlyDictionary<string, string> columns)
    {
        lock (Lock)
        {
            PromptColumns.Clear();
            foreach ((string name, string column) in columns.OrderBy(kv => string.Equals(kv.Key, DatasetCatalog.CanonicalName(kv.Key), StringComparison.OrdinalIgnoreCase)))
            {
                if (!string.IsNullOrWhiteSpace(column))
                {
                    PromptColumns[DatasetCatalog.CanonicalName(name)] = column;
                }
            }
        }
    }

    public static IReadOnlyDictionary<string, string> GetPromptColumnsSnapshot()
    {
        lock (Lock)
        {
            return new Dictionary<string, string>(PromptColumns);
        }
    }

    public static IReadOnlyList<string> GetTagColumns(string name)
    {
        lock (Lock)
        {
            return TagColumns.TryGetValue(DatasetCatalog.CanonicalName(name), out List<string> columns) ? [.. columns] : [];
        }
    }

    public static void SetTagColumns(IReadOnlyDictionary<string, IReadOnlyList<string>> columns)
    {
        lock (Lock)
        {
            TagColumns.Clear();
            foreach ((string name, IReadOnlyList<string> cols) in columns.OrderBy(kv => string.Equals(kv.Key, DatasetCatalog.CanonicalName(kv.Key), StringComparison.OrdinalIgnoreCase)))
            {
                List<string> kept = cols is null ? [] : [.. cols.Where(c => !string.IsNullOrWhiteSpace(c))];
                if (kept.Count > 0)
                {
                    TagColumns[DatasetCatalog.CanonicalName(name)] = kept;
                }
            }
        }
    }

    public static IReadOnlyDictionary<string, IReadOnlyList<string>> GetTagColumnsSnapshot()
    {
        lock (Lock)
        {
            return TagColumns.ToDictionary(kv => kv.Key, kv => (IReadOnlyList<string>)[.. kv.Value]);
        }
    }
}
