namespace Quarry;

/// <summary>How many of a clause's listed values a row must match. Matching is always "contains",
/// never exact: a scalar/text column contains the value as a case-insensitive substring; a list column
/// has the value as an element.</summary>
public enum MatchOp
{
    /// <summary><c>=</c> — the column matches at least ONE of the values (contains-any / list_has_any).</summary>
    Any,

    /// <summary><c>==</c> — the column matches ALL of the values (contains-all / list_has_all).</summary>
    All,

    /// <summary><c>!=</c> — the column matches NONE of the values.</summary>
    None,
}

/// <summary>A single <c>column op values</c> filter, e.g. <c>tags==brunette,punk</c> or <c>Prompt=girl</c>.</summary>
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

/// <summary>A parsed wildcard reference: a wildcard <see cref="Name"/> plus zero or more
/// AND-ed filter <see cref="Clauses"/> (a row must satisfy every clause).</summary>
public sealed class WildcardQuery
{
    public string Name { get; }
    public IReadOnlyList<QueryClause> Clauses { get; }

    /// <summary>True when the reference carried a <c>[...]</c> filter.</summary>
    public bool HasFilter => Clauses.Count > 0;

    public WildcardQuery(string name, IReadOnlyList<QueryClause> clauses)
    {
        Name = name;
        Clauses = clauses;
    }
}
