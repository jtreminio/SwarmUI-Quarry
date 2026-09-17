namespace Quarry;

public enum ColumnKind
{
    Scalar,
    List,
    Object,
}

public sealed record SearchHelper(string Column, string Field, string Kind, string Physical);

public sealed class ColumnInfo(string name, ColumnKind kind, bool isNumeric = false, bool hasNgramIndex = false, string numericType = null, string casingColumn = null, bool isCasingPatch = false, string dataType = null, bool isSearchHelper = false)
{
    public string Name { get; } = name;
    public ColumnKind Kind { get; } = kind;
    public bool IsNumeric { get; } = isNumeric;
    public bool HasNgramIndex { get; } = hasNgramIndex;
    public string NumericType { get; } = numericType;
    public string CasingColumn { get; } = casingColumn;
    public bool IsCasingPatch { get; } = isCasingPatch;
    public bool IsSearchHelper { get; } = isSearchHelper;
    public string DataType { get; } = dataType;
    private IReadOnlyList<ColumnInfo> _fields;
    public IReadOnlyList<ColumnInfo> Fields => _fields ??= ComplexTypes.Fields(DataType);
    public bool IsRecord => Kind == ColumnKind.Object || Fields.Count > 0;
}

public sealed class ColumnSchema
{
    // Deprecated storage format; retained for existing datasets and image history.
    public const string CompanionSuffix = "__lc";
    private readonly List<ColumnInfo> _ordered;
    private readonly Dictionary<string, ColumnInfo> _byName;
    private IReadOnlyList<ColumnInfo> _visible;

    public ColumnSchema(IEnumerable<ColumnInfo> columns, IEnumerable<SearchHelper> searchHelpers = null)
    {
        _ordered = [.. columns];
        _byName = new Dictionary<string, ColumnInfo>(StringComparer.OrdinalIgnoreCase);
        foreach (ColumnInfo column in _ordered)
        {
            _byName[column.Name] = column;
        }
        SearchHelpers = searchHelpers?.ToArray() ?? [];
    }

    public IReadOnlyList<ColumnInfo> Columns => _ordered;
    public IReadOnlyList<SearchHelper> SearchHelpers { get; }

    public IReadOnlyList<ColumnInfo> VisibleColumns =>
        _visible ??= _ordered.Any(c => IsCompanionName(c.Name))
            ? [.. _ordered.Where(c => !IsCompanionName(c.Name))]
            : _ordered;

    public bool IsCompanionName(string name)
        => (_byName.TryGetValue(name, out ColumnInfo column) && (column.IsCasingPatch || column.IsSearchHelper))
            || (name.Length > CompanionSuffix.Length
                && name.EndsWith(CompanionSuffix, StringComparison.OrdinalIgnoreCase));

    public bool TryGet(string column, out ColumnInfo info) => _byName.TryGetValue(column, out info);

    public static (List<string> Columns, List<List<string>> Rows) StripCompanions(List<string> columns, List<List<string>> rows)
    {
        bool[] keep = new bool[columns.Count];
        bool anyDropped = false;
        for (int i = 0; i < columns.Count; i++)
        {
            bool companion = columns[i].Length > CompanionSuffix.Length
                && columns[i].EndsWith(CompanionSuffix, StringComparison.OrdinalIgnoreCase);
            keep[i] = !companion;
            anyDropped |= companion;
        }
        if (!anyDropped)
        {
            return (columns, rows);
        }
        List<string> keptColumns = [.. columns.Where((_, i) => keep[i])];
        List<List<string>> keptRows = [];
        foreach (List<string> row in rows)
        {
            keptRows.Add([.. row.Where((_, i) => i < keep.Length && keep[i])]);
        }
        return (keptColumns, keptRows);
    }
}
