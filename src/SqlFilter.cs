namespace Quarry;

public sealed class QueryParameter(string name, string value)
{
    public string Name { get; } = name;
    public string Value { get; } = value;
}

public sealed class SqlFilter(string whereClause, IReadOnlyList<QueryParameter> parameters, NestedOutput output = null,
    string candidateWhereClause = "", IReadOnlyList<QueryParameter> candidateParameters = null,
    IReadOnlyList<SearchHelper> candidateHelpers = null, string candidateOrderColumn = "__quarry_source_ordinal",
    bool requiresRecordScan = false)
{
    public static readonly SqlFilter None = new("", []);
    public string WhereClause { get; } = whereClause;
    public IReadOnlyList<QueryParameter> Parameters { get; } = parameters;
    public NestedOutput Output { get; } = output;
    public string CandidateWhereClause { get; } = candidateWhereClause;
    public IReadOnlyList<QueryParameter> CandidateParameters { get; } = candidateParameters ?? [];
    public IReadOnlyList<SearchHelper> CandidateHelpers { get; } = candidateHelpers ?? [];
    public string CandidateOrderColumn { get; } = candidateOrderColumn;
    public bool RequiresRecordScan { get; } = requiresRecordScan;
    public bool IsEmpty => WhereClause.Length == 0;

    public string CacheKey => IsEmpty
        ? ""
        : $"{WhereClause.Length}:{WhereClause}|{string.Join("|", Parameters.Select(parameter => $"{parameter.Value.Length}:{parameter.Value}"))}"
            + $"|{CandidateWhereClause.Length}:{CandidateWhereClause}|{string.Join("|", CandidateParameters.Select(p => $"{p.Value.Length}:{p.Value}"))}";
}
