namespace Quarry;

public enum MatchOp
{
    Any,
    All,
    None,
}

public sealed class QueryClause(string column, MatchOp op, IReadOnlyList<string> values)
{
    public string Column { get; } = column;
    public MatchOp Op { get; } = op;
    public IReadOnlyList<string> Values { get; } = values;
}

public sealed class WildcardQuery(string name, IReadOnlyList<QueryClause> clauses)
{
    public string Name { get; } = name;
    public IReadOnlyList<QueryClause> Clauses { get; } = clauses;
    public bool HasFilter => Clauses.Count > 0;
}
