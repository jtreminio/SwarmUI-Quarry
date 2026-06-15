namespace Quarry;

/// <summary>How many of a clause's values a row must match. Always "contains", never exact: a scalar column
/// contains the value as a case-insensitive substring; a list column has it as an element.</summary>
public enum MatchOp
{
    /// <summary><c>=</c> — matches at least ONE value.</summary>
    Any,

    /// <summary><c>==</c> — matches ALL values.</summary>
    All,

    /// <summary><c>!=</c> — matches NONE of the values.</summary>
    None,
}

/// <summary>A single <c>column op values</c> filter, e.g. <c>tags==brunette,punk</c>.</summary>
public sealed class QueryClause
{
    public string Column { get; }
    public MatchOp Op { get; }
    public IReadOnlyList<string> Values { get; }

    public QueryClause(string column, MatchOp op, IReadOnlyList<string> values)
    {
        Column = column;
        Op = op;
        Values = values;
    }
}

/// <summary>A parsed reference: a <see cref="Name"/> plus zero or more AND-ed filter <see cref="Clauses"/>.</summary>
public sealed class WildcardQuery
{
    public string Name { get; }
    public IReadOnlyList<QueryClause> Clauses { get; }

    public bool HasFilter => Clauses.Count > 0;

    public WildcardQuery(string name, IReadOnlyList<QueryClause> clauses)
    {
        Name = name;
        Clauses = clauses;
    }
}
