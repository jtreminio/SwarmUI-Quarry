namespace Quarry;

/// <summary>Whether a dataset column holds a single scalar value or a list/array of values.
/// Determines which SQL matching strategy <see cref="SqlFilterBuilder"/> uses.</summary>
public enum ColumnKind
{
    Scalar,
    List,
}

/// <summary>One dataset column: its canonical name (exact casing as stored in the dataset) and
/// whether it is scalar or list-typed.</summary>
public sealed class ColumnInfo
{
    public string Name { get; }
    public ColumnKind Kind { get; }

    public ColumnInfo(string name, ColumnKind kind)
    {
        Name = name;
        Kind = kind;
    }
}

/// <summary>The columns of a dataset, as introspected from DuckDB's <c>DESCRIBE</c>. Preserves column
/// order (so "first column" is meaningful) while offering case-insensitive lookup that always resolves
/// back to a column's canonical casing (DuckDB quoted identifiers are case-sensitive).</summary>
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

    /// <summary>Columns in dataset order.</summary>
    public IReadOnlyList<ColumnInfo> Columns => _ordered;

    /// <summary>Resolves a user-supplied column name (any casing) to its canonical
    /// <see cref="ColumnInfo"/>. Returns false when no such column exists.</summary>
    public bool TryGet(string column, out ColumnInfo info) => _byName.TryGetValue(column, out info);
}
