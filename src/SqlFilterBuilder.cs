namespace Quarry;

// Matching is always case-insensitive "contains", never exact: a scalar column by substring, a list
// column by substring against each element (so `girl` matches `girls` and `young girl`). Values are
// always bound as parameters, never interpolated. Pure, so it can be unit-tested without a database.
public static class SqlFilterBuilder
{
    // Reserved clause column that expands to a dataset's configured tag columns, searched as one merged column.
    public const string TagsKeyword = "tags";

    public static SqlFilter Build(WildcardQuery query, ColumnSchema schema)
        => Build(query, schema, Array.Empty<ColumnInfo>());

    public static SqlFilter Build(WildcardQuery query, ColumnSchema schema, IReadOnlyList<ColumnInfo> tagColumns)
    {
        if (!query.HasFilter)
        {
            return SqlFilter.None;
        }
        List<string> terms = [];
        List<QueryParameter> parameters = [];
        foreach (QueryClause clause in query.Clauses)
        {
            if (tagColumns.Count > 0 && string.Equals(clause.Column, TagsKeyword, StringComparison.OrdinalIgnoreCase))
            {
                terms.Add(BuildMergedTagTerm(tagColumns, clause, parameters));
                continue;
            }
            if (!schema.TryGet(clause.Column, out ColumnInfo column))
            {
                throw new WildcardQueryException(
                    $"Column '{clause.Column}' does not exist in dataset '{query.Name}'.");
            }
            string quoted = SqlText.QuoteIdentifier(column.Name);
            string[] placeholders = new string[clause.Values.Count];
            for (int i = 0; i < clause.Values.Count; i++)
            {
                string name = $"p{parameters.Count}";
                parameters.Add(new QueryParameter(name, clause.Values[i]));
                placeholders[i] = $"${name}";
            }
            terms.Add(column.Kind == ColumnKind.List
                ? BuildListTerm(quoted, clause, placeholders)
                : BuildContainsTerm(quoted, clause, placeholders));
        }
        return new SqlFilter(string.Join(" AND ", terms), parameters);
    }

    // The `tags` keyword: configured tag columns treated as one merged column. Each value is bound once
    // and matches if present in ANY tag column; Any/All/None then combine across values as usual.
    private static string BuildMergedTagTerm(IReadOnlyList<ColumnInfo> tagColumns, QueryClause clause, List<QueryParameter> parameters)
    {
        string[] valueMatches = new string[clause.Values.Count];
        for (int i = 0; i < clause.Values.Count; i++)
        {
            string name = $"p{parameters.Count}";
            parameters.Add(new QueryParameter(name, clause.Values[i]));
            string placeholder = $"${name}";
            string[] perColumn = new string[tagColumns.Count];
            for (int c = 0; c < tagColumns.Count; c++)
            {
                string quoted = SqlText.QuoteIdentifier(tagColumns[c].Name);
                perColumn[c] = tagColumns[c].Kind == ColumnKind.List
                    ? ListElementContains(quoted, placeholder)
                    : ScalarContains(quoted, placeholder);
            }
            valueMatches[i] = perColumn.Length == 1 ? perColumn[0] : $"({string.Join(" OR ", perColumn)})";
        }
        return Combine(clause, valueMatches);
    }

    private static string BuildContainsTerm(string column, QueryClause clause, string[] placeholders)
        => Combine(clause, [.. placeholders.Select(p => ScalarContains(column, p))]);

    private static string BuildListTerm(string column, QueryClause clause, string[] placeholders)
        => Combine(clause, [.. placeholders.Select(p => ListElementContains(column, p))]);

    // Using contains() rather than LIKE avoids escaping `%` and `_` in user values.
    private static string ScalarContains(string column, string placeholder)
        => $"contains(lower({column}), lower({placeholder}))";

    // A list lambda stays one scan (no row explosion), unlike UNNEST.
    private static string ListElementContains(string column, string placeholder)
        => $"len(list_filter({column}, x -> contains(lower(x), lower({placeholder})))) > 0";

    private static string Combine(QueryClause clause, IReadOnlyList<string> checks) => clause.Op switch
    {
        MatchOp.Any => $"({string.Join(" OR ", checks)})",
        MatchOp.All => $"({string.Join(" AND ", checks)})",
        MatchOp.None => $"NOT ({string.Join(" OR ", checks)})",
        _ => throw new WildcardQueryException($"Unsupported operator for column '{clause.Column}'."),
    };
}
