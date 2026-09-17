using System.Text.Json;

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
        (data, OutputFormat format) = SplitFormat(data);
        (string head, IReadOnlyList<string> promptColumns) = SplitPromptColumns(data);
        head = head.Trim();
        int open = head.IndexOf('[');
        if (open < 0)
        {
            string bareName = head.Trim();
            if (bareName.Length == 0)
            {
                throw new QueryParseException("Dataset name is empty.");
            }
            return new Query(bareName, [], promptColumns, format);
        }
        if (head.Length == 0 || head[^1] != ']')
        {
            throw new QueryParseException($"Query '{data}' is missing a closing ']'.");
        }
        string name = head[..open].Trim();
        string body = head[(open + 1)..^1];
        List<QueryClause> clauses = ParseClauses(body, data);
        if (clauses.Count == 0)
        {
            throw new QueryParseException(
                $"Query '{data}' has an empty '[]' filter; remove the brackets or add a clause.");
        }
        return new Query(name, clauses, promptColumns, format);
    }

    private static (string head, IReadOnlyList<string> promptColumns) SplitPromptColumns(string data)
    {
        int colon = FindTopLevel(data, ':');
        if (colon < 0)
        {
            return (data, []);
        }
        string[] columns = data[(colon + 1)..].Split(',', StringSplitOptions.TrimEntries);
        if (columns.Any(column => column.Length == 0))
        {
            throw new QueryParseException($"Query '{data}' has an empty prompt column after ':'.");
        }
        return (data[..colon], columns);
    }

    // Delimiters inside selectors or JSON-quoted formatting strings are literal.
    internal static int FindTopLevel(string text, char delimiter, bool quotedStrings = false)
    {
        int depth = 0;
        bool quoted = false, escaped = false;
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (quoted)
            {
                if (escaped)
                {
                    escaped = false;
                }
                else if (c == '\\')
                {
                    escaped = true;
                }
                else if (c == '"')
                {
                    quoted = false;
                }

                continue;
            }
            if (c == '"' && quotedStrings) { quoted = true; continue; }
            if (c == '[')
            {
                depth++;
            }
            else if (c == ']')
            {
                if (--depth < 0)
                {
                    throw new QueryParseException("Unexpected closing ']'.");
                }
            }
            else if (c == delimiter && depth == 0)
            {
                return i;
            }
        }
        if (quoted || depth != 0)
        {
            throw new QueryParseException("Unclosed quote or selector bracket.");
        }

        return -1;
    }

    private static (string, OutputFormat) SplitFormat(string data)
    {
        int pipe = FindTopLevel(data, '|');
        if (pipe < 0)
        {
            return (data, new());
        }

        string options = data[(pipe + 1)..].Trim();
        if (options.Length == 0)
        {
            throw new QueryParseException("Output options after '|' are empty.");
        }

        OutputFormat format = new();
        HashSet<string> seen = new(StringComparer.Ordinal);
        while (options.Length > 0)
        {
            int semi = FindTopLevel(options, ';', quotedStrings: true);
            string option = (semi < 0 ? options : options[..semi]).Trim();
            options = semi < 0 ? "" : options[(semi + 1)..].Trim();
            int equals = option.IndexOf('=');
            string key = (equals < 0 ? option : option[..equals]).Trim();
            key = key switch { "rs" => "record_separator", "fs" => "field_separator", _ => key };
            if (!seen.Add(key))
            {
                throw new QueryParseException($"Duplicate output option '{key}'.");
            }

            if (key == "keys" && equals < 0) { format = format with { Keys = true }; continue; }
            if (key is not ("record_separator" or "field_separator") || equals < 0)
            {
                throw new QueryParseException($"Unknown output option '{option}'. Use keys, record_separator (rs), or field_separator (fs).");
            }

            string raw = option[(equals + 1)..].Trim();
            string separator;
            try { separator = JsonSerializer.Deserialize<string>(raw); }
            catch (JsonException) { throw new QueryParseException($"Separator '{key}' must be a double-quoted string."); }
            if (separator is null)
            {
                throw new QueryParseException($"Separator '{key}' must be a double-quoted string.");
            }

            format = key == "record_separator" ? format with { RecordSeparator = separator } : format with { FieldSeparator = separator };
        }
        return (data[..pipe].TrimEnd(), format);
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
                $"Clause '{clause}' in '{original}' is missing an operator (=, ==, !=, +=, or -=).");
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
        else if (eq > 0 && clause[eq - 1] == '+')
        {
            op = MatchOp.GreaterOrEqual;
            columnEnd = eq - 1;
            valueStart = eq + 1;
        }
        else if (eq > 0 && clause[eq - 1] == '-')
        {
            op = MatchOp.LessOrEqual;
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
