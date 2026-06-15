namespace Quarry;

/// <summary>Translates a parsed <see cref="WildcardQuery"/> plus a dataset <see cref="ColumnSchema"/>
/// into a parameterized DuckDB WHERE expression. Matching is always "contains", never exact: a
/// scalar/text column is matched by case-insensitive substring; a list column by case-insensitive
/// substring against each element (so <c>girl</c> matches the elements <c>girls</c> and <c>young girl</c>).
/// Column identifiers are validated against the schema and double-quoted using their canonical casing;
/// every value is bound as a parameter. Pure and side-effect free, so it can be unit-tested without a
/// database.</summary>
public static class SqlFilterBuilder
{
    /// <summary>The reserved clause column name that expands to a dataset's configured tag columns, searched
    /// together as one merged column. See <see cref="TagColumnResolver"/>.</summary>
    public const string TagsKeyword = "tags";

    public static SqlFilter Build(WildcardQuery query, ColumnSchema schema)
        => Build(query, schema, Array.Empty<ColumnInfo>());

    /// <summary>Builds the WHERE expression. A clause whose column is the <see cref="TagsKeyword"/> and that
    /// has at least one resolved <paramref name="tagColumns"/> entry matches across all of those columns as a
    /// single merged column; every other clause (including <c>tags</c> when nothing is configured) is matched
    /// against the literal schema column, exactly as before.</summary>
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
            string quoted = QuoteIdentifier(column.Name);
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

    /// <summary>The <c>tags</c> keyword: the configured tag columns are treated as one merged column. Each
    /// value is bound once (reused across columns) and matches if it is present in ANY tag column — a scalar
    /// column via case-insensitive substring, a list column via case-insensitive substring against each
    /// element. <c>=</c> needs any value to match, <c>==</c> needs every value to match (cumulatively across
    /// columns), <c>!=</c> needs none.</summary>
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
                string quoted = QuoteIdentifier(tagColumns[c].Name);
                perColumn[c] = tagColumns[c].Kind == ColumnKind.List
                    ? ListElementContains(quoted, placeholder)
                    : $"contains(lower({quoted}), lower({placeholder}))";
            }
            valueMatches[i] = perColumn.Length == 1 ? perColumn[0] : $"({string.Join(" OR ", perColumn)})";
        }
        return clause.Op switch
        {
            MatchOp.Any => $"({string.Join(" OR ", valueMatches)})",
            MatchOp.All => $"({string.Join(" AND ", valueMatches)})",
            MatchOp.None => $"NOT ({string.Join(" OR ", valueMatches)})",
            _ => throw new WildcardQueryException($"Unsupported operator for column '{clause.Column}'."),
        };
    }

    /// <summary>Scalar/text column: case-insensitive substring via <c>contains(lower(col), lower($p))</c>.
    /// Using contains() rather than LIKE avoids having to escape <c>%</c> and <c>_</c> in user values.</summary>
    private static string BuildContainsTerm(string column, QueryClause clause, string[] placeholders)
    {
        string[] checks = new string[placeholders.Length];
        for (int i = 0; i < placeholders.Length; i++)
        {
            checks[i] = $"contains(lower({column}), lower({placeholders[i]}))";
        }
        return clause.Op switch
        {
            MatchOp.Any => $"({string.Join(" OR ", checks)})",
            MatchOp.All => $"({string.Join(" AND ", checks)})",
            MatchOp.None => $"NOT ({string.Join(" OR ", checks)})",
            _ => throw new WildcardQueryException($"Unsupported operator for column '{clause.Column}'."),
        };
    }

    /// <summary>List column: case-insensitive substring against each element. A value matches when ANY element
    /// of the list contains it (so <c>girl</c> matches <c>girls</c> and <c>young girl</c>). <c>=</c> needs any
    /// value to match an element, <c>==</c> needs every value to, <c>!=</c> needs none.</summary>
    private static string BuildListTerm(string column, QueryClause clause, string[] placeholders)
    {
        string[] checks = new string[placeholders.Length];
        for (int i = 0; i < placeholders.Length; i++)
        {
            checks[i] = ListElementContains(column, placeholders[i]);
        }
        return clause.Op switch
        {
            MatchOp.Any => $"({string.Join(" OR ", checks)})",
            MatchOp.All => $"({string.Join(" AND ", checks)})",
            MatchOp.None => $"NOT ({string.Join(" OR ", checks)})",
            _ => throw new WildcardQueryException($"Unsupported operator for column '{clause.Column}'."),
        };
    }

    /// <summary>True when any element of the list <paramref name="column"/> contains <paramref name="placeholder"/>
    /// as a case-insensitive substring. Uses a list lambda (one pass over the elements, no row explosion) so it
    /// stays a single scan, unlike UNNEST.</summary>
    private static string ListElementContains(string column, string placeholder)
        => $"len(list_filter({column}, x -> contains(lower(x), lower({placeholder})))) > 0";

    /// <summary>Double-quotes a DuckDB identifier, escaping embedded double-quotes by doubling them.</summary>
    private static string QuoteIdentifier(string identifier) => $"\"{identifier.Replace("\"", "\"\"")}\"";
}
