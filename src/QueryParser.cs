namespace Quarry;

public sealed class QueryParseException(string message) : QueryException(message)
{
}

public static class QueryParser
{
    public static Query Parse(string data)
    {
        if (data is null)
        {
            throw new QueryParseException("Query is null.");
        }
        (string head, string promptColumn) = SplitPromptColumn(data);
        int open = head.IndexOf('[');
        if (open < 0)
        {
            string bareName = head.Trim();
            if (bareName.Length == 0)
            {
                throw new QueryParseException("Dataset name is empty.");
            }
            return new Query(bareName, [], promptColumn);
        }
        if (head.Length == 0 || head[^1] != ']')
        {
            throw new QueryParseException($"Query '{data}' is missing a closing ']'.");
        }
        string name = head[..open].Trim();
        if (name.Length == 0)
        {
            throw new QueryParseException($"Query '{data}' has an empty name.");
        }
        string body = head[(open + 1)..^1];
        List<QueryClause> clauses = ParseClauses(body, data);
        if (clauses.Count == 0)
        {
            throw new QueryParseException(
                $"Query '{data}' has an empty '[]' filter; remove the brackets or add a clause.");
        }
        return new Query(name, clauses, promptColumn);
    }

    /// Peels off the optional ":column" prompt-column override that trails the name and any "[filter]".
    /// The separator is searched for only AFTER the filter's closing ']' so a ':' inside a filter value
    /// (e.g. a url) is never mistaken for it. Returns the remaining head (name + filter) and the column,
    /// or the original data and null when no override is present.
    private static (string head, string promptColumn) SplitPromptColumn(string data)
    {
        int searchFrom = data.LastIndexOf(']') + 1;
        int colon = data.IndexOf(':', searchFrom);
        if (colon < 0)
        {
            return (data, null);
        }
        string column = data[(colon + 1)..].Trim();
        if (column.Length == 0)
        {
            throw new QueryParseException($"Query '{data}' has an empty prompt column after ':'.");
        }
        return (data[..colon], column);
    }

    private static List<QueryClause> ParseClauses(string body, string original)
    {
        List<QueryClause> clauses = [];
        foreach (string rawClause in body.Split(';'))
        {
            string clause = rawClause.Trim();
            if (clause.Length == 0)
            {
                continue;
            }
            clauses.Add(ParseClause(clause, original));
        }
        return clauses;
    }

    private static QueryClause ParseClause(string clause, string original)
    {
        int eq = clause.IndexOf('=');
        if (eq < 0)
        {
            throw new QueryParseException(
                $"Clause '{clause}' in '{original}' is missing an operator (=, ==, or !=).");
        }
        MatchOp op;
        int columnEnd;
        int valueStart;
        if (eq > 0 && clause[eq - 1] == '!')
        {
            op = MatchOp.None;
            columnEnd = eq - 1;
            valueStart = eq + 1;
        }
        else if (eq + 1 < clause.Length && clause[eq + 1] == '=')
        {
            op = MatchOp.All;
            columnEnd = eq;
            valueStart = eq + 2;
        }
        else
        {
            op = MatchOp.Any;
            columnEnd = eq;
            valueStart = eq + 1;
        }
        string column = clause[..columnEnd].Trim();
        if (column.Length == 0)
        {
            throw new QueryParseException($"Clause '{clause}' in '{original}' is missing a column name.");
        }
        IReadOnlyList<string> values = ParseValues(clause[valueStart..], clause, original);
        return new QueryClause(column, op, values);
    }

    private static IReadOnlyList<string> ParseValues(string raw, string clause, string original)
    {
        List<string> values = [];
        foreach (string part in raw.Split(','))
        {
            string value = part.Trim();
            if (value.Length > 0)
            {
                values.Add(value);
            }
        }
        if (values.Count == 0)
        {
            throw new QueryParseException(
                $"Clause '{clause}' in '{original}' has no values after the operator.");
        }
        return values;
    }
}
