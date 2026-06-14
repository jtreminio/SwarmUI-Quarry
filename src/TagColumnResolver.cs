namespace Quarry;

/// <summary>Resolves a dataset's user-configured tag column names against its actual
/// <see cref="ColumnSchema"/>: keeps only the names that exist (any casing), maps each to its canonical
/// <see cref="ColumnInfo"/>, drops duplicates, and preserves the configured order. Columns that are not in
/// the schema are silently ignored. Pure and side-effect free — mirrors <see cref="PromptColumnResolver"/>.
///
/// The returned list is what <see cref="SqlFilterBuilder"/> treats as a single "merged" column when a clause
/// uses the <c>tags</c> keyword. When nothing is configured (or none of the configured names exist), it falls
/// back to <paramref name="fallbackColumn"/> — typically the resolved prompt column — so <c>tags</c> still
/// searches something useful on files that were never set up (e.g. a single-column prompt file).</summary>
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
