namespace Quarry;

/// <summary>Maps a DuckDB column type string (as returned by <c>DESCRIBE</c>) to a
/// <see cref="ColumnKind"/>. List/array types (e.g. <c>VARCHAR[]</c>, <c>INTEGER[3]</c>,
/// <c>LIST(VARCHAR)</c>) become <see cref="ColumnKind.List"/>; everything else is scalar.
/// Pure and side-effect free.</summary>
public static class DuckDbTypeMapper
{
    public static ColumnKind MapKind(string duckDbType)
    {
        if (string.IsNullOrWhiteSpace(duckDbType))
        {
            return ColumnKind.Scalar;
        }
        string type = duckDbType.Trim();
        bool isList = type.EndsWith(']')
            || type.StartsWith("LIST(", StringComparison.OrdinalIgnoreCase)
            || type.StartsWith("ARRAY(", StringComparison.OrdinalIgnoreCase);
        return isList ? ColumnKind.List : ColumnKind.Scalar;
    }
}
