namespace Quarry;

// A query parameter, always bound rather than interpolated to prevent SQL injection from user tag text.
public sealed class QueryParameter
{
    public string Name { get; }
    public string Value { get; }

    public QueryParameter(string name, string value)
    {
        Name = name;
        Value = value;
    }
}

// A SQL WHERE expression (without the leading WHERE) plus its bound parameters; empty when unfiltered.
public sealed class SqlFilter
{
    public static readonly SqlFilter None = new("", Array.Empty<QueryParameter>());

    public string WhereClause { get; }
    public IReadOnlyList<QueryParameter> Parameters { get; }

    public bool IsEmpty => WhereClause.Length == 0;

    // Stable key for the row-count cache. Each part is length-prefixed (`len:text`) so value content can
    // never be confused for structure (two values `[a, b]` won't collide with the single value `a|b`).
    public string CacheKey => IsEmpty
        ? ""
        : $"{WhereClause.Length}:{WhereClause}|{string.Join("|", Parameters.Select(parameter => $"{parameter.Value.Length}:{parameter.Value}"))}";

    public SqlFilter(string whereClause, IReadOnlyList<QueryParameter> parameters)
    {
        WhereClause = whereClause;
        Parameters = parameters;
    }
}
