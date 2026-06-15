namespace Quarry;

public enum ColumnKind
{
    Scalar,
    List,
}

public sealed class ColumnInfo(string name, ColumnKind kind)
{
    public string Name { get; } = name;
    public ColumnKind Kind { get; } = kind;
}

// Preserves dataset column order while offering case-insensitive lookup back to canonical casing
// (DuckDB quoted identifiers are case-sensitive).
public sealed class ColumnSchema
{
    private readonly List<ColumnInfo> _ordered;
    private readonly Dictionary<string, ColumnInfo> _byName;

    public ColumnSchema(IEnumerable<ColumnInfo> columns)
    {
        _ordered = [.. columns];
        _byName = new Dictionary<string, ColumnInfo>(StringComparer.OrdinalIgnoreCase);
        foreach (ColumnInfo column in _ordered)
        {
            _byName[column.Name] = column;
        }
    }

    public IReadOnlyList<ColumnInfo> Columns => _ordered;

    public bool TryGet(string column, out ColumnInfo info) => _byName.TryGetValue(column, out info);
}
