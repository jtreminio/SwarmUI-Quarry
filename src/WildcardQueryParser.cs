namespace Quarry;

public sealed class WildcardQueryParseException(string message) : WildcardQueryException(message)
{
}

public static class WildcardQueryParser
{
    public static WildcardQuery Parse(string data)
    {
        if (data is null)
        {
            throw new WildcardQueryParseException("Wildcard query is null.");
        }
        int open = data.IndexOf('[');
        if (open < 0)
        {
            string bareName = data.Trim();
            if (bareName.Length == 0)
            {
                throw new WildcardQueryParseException("Wildcard name is empty.");
            }
            return new WildcardQuery(bareName, []);
        }
        if (data.Length == 0 || data[^1] != ']')
        {
            throw new WildcardQueryParseException($"Wildcard query '{data}' is missing a closing ']'.");
        }
        string name = data[..open].Trim();
        if (name.Length == 0)
        {
            throw new WildcardQueryParseException($"Wildcard query '{data}' has an empty name.");
        }
        string body = data[(open + 1)..^1];
        List<QueryClause> clauses = ParseClauses(body, data);
        if (clauses.Count == 0)
        {
            throw new WildcardQueryParseException(
                $"Wildcard query '{data}' has an empty '[]' filter; remove the brackets or add a clause.");
        }
        return new WildcardQuery(name, clauses);
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
            throw new WildcardQueryParseException(
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
            throw new WildcardQueryParseException($"Clause '{clause}' in '{original}' is missing a column name.");
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
            throw new WildcardQueryParseException(
                $"Clause '{clause}' in '{original}' has no values after the operator.");
        }
        return values;
    }
}
