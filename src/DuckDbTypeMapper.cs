namespace Quarry;

// Maps a DuckDB DESCRIBE type string to a ColumnKind; list/array types (VARCHAR[], INTEGER[3], LIST(...)) are List.
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
