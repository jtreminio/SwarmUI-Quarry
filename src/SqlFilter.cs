namespace Quarry;

public sealed class QueryParameter(string name, string value)
{
    public string Name { get; } = name;
    public string Value { get; } = value;
}

public sealed class SqlFilter(string whereClause, IReadOnlyList<QueryParameter> parameters)
{
    public static readonly SqlFilter None = new("", []);
    public string WhereClause { get; } = whereClause;
    public IReadOnlyList<QueryParameter> Parameters { get; } = parameters;
    public bool IsEmpty => WhereClause.Length == 0;

    public string CacheKey => IsEmpty
        ? ""
        : $"{WhereClause.Length}:{WhereClause}|{string.Join("|", Parameters.Select(parameter => $"{parameter.Value.Length}:{parameter.Value}"))}";
}
