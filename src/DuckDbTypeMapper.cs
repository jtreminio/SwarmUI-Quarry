namespace Quarry;

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
        return isList ? ColumnKind.List : type.StartsWith("STRUCT(", StringComparison.OrdinalIgnoreCase) ? ColumnKind.Object : ColumnKind.Scalar;
    }

    private static readonly HashSet<string> NumericTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "TINYINT", "INT1",
        "SMALLINT", "INT2", "SHORT",
        "INTEGER", "INT", "INT4", "SIGNED",
        "BIGINT", "INT8", "LONG",
        "HUGEINT",
        "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT",
        "FLOAT", "FLOAT4", "REAL",
        "DOUBLE", "FLOAT8",
        "DECIMAL", "NUMERIC",
    };

    private static readonly HashSet<string> IntegerTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "TINYINT", "INT1",
        "SMALLINT", "INT2", "SHORT",
        "INTEGER", "INT", "INT4", "SIGNED",
        "BIGINT", "INT8", "LONG",
        "HUGEINT",
        "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT",
    };

    public static bool IsNumeric(string duckDbType) => BaseTypeName(duckDbType) is { } name && NumericTypes.Contains(name);

    public static bool IsIntegerType(string duckDbType) => BaseTypeName(duckDbType) is { } name && IntegerTypes.Contains(name);

    private static string BaseTypeName(string duckDbType)
    {
        if (string.IsNullOrWhiteSpace(duckDbType) || MapKind(duckDbType) == ColumnKind.List)
        {
            return null;
        }
        string type = duckDbType.Trim();
        int paren = type.IndexOf('(');
        return paren >= 0 ? type[..paren].Trim() : type;
    }
}
