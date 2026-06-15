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

public sealed class Query(string name, IReadOnlyList<QueryClause> clauses, string promptColumn = null)
{
    public string Name { get; } = name;
    public IReadOnlyList<QueryClause> Clauses { get; } = clauses;

    /// The column the tag asked to read the prompt from (the optional ":column" suffix), or null when the
    /// tag did not specify one. Applied per-file with a fallback to each dataset's default prompt column.
    public string PromptColumn { get; } = promptColumn;

    public bool HasFilter => Clauses.Count > 0;
}
