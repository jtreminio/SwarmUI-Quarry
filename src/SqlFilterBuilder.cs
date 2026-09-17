namespace Quarry;

public static class SqlFilterBuilder
{
    public const string TagsKeyword = "tags";
    public static SqlFilter Build(Query query, ColumnSchema schema) => Build(query, schema, []);

    public static SqlFilter Build(Query query, ColumnSchema schema, IReadOnlyList<ColumnInfo> tagColumns)
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
                if (clause.Op is MatchOp.GreaterOrEqual or MatchOp.LessOrEqual)
                {
                    terms.Add(BuildMergedTagComparisonTerm(tagColumns, clause, parameters));
                    continue;
                }
                terms.Add(BuildMergedTagTerm(tagColumns, clause, parameters, schema));
                continue;
            }
            if (!schema.TryGet(clause.Column, out ColumnInfo column))
            {
                throw new QueryException(
                    $"Column '{clause.Column}' does not exist in dataset '{query.Name}'.");
            }
            if (column.IsCasingPatch || column.IsSearchHelper)
            {
                throw new QueryException("Internal storage columns cannot be queried directly.");
            }
            string quoted = SqlText.QuoteIdentifier(column.Name);
            if (clause.Op is MatchOp.GreaterOrEqual or MatchOp.LessOrEqual)
            {
                if (column.Kind == ColumnKind.Object)
                {
                    throw new NonNumericComparisonException(column.Name);
                }
                terms.Add(BuildComparisonTerm(column, clause, parameters));
                continue;
            }
            terms.Add(column.Kind == ColumnKind.List
                ? BuildListTerm(quoted, clause, parameters)
                : BuildContainsTerm(column, schema, clause, parameters));
        }
        return new SqlFilter(string.Join(" AND ", terms), parameters);
    }

    private static string BuildMergedTagTerm(IReadOnlyList<ColumnInfo> tagColumns, QueryClause clause, List<QueryParameter> parameters, ColumnSchema schema)
    {
        string[] valueMatches = new string[clause.Values.Count];
        for (int i = 0; i < clause.Values.Count; i++)
        {
            string value = MatchValue(clause.Values[i]);
            string placeholder = null, encodedPlaceholder = null;
            if (tagColumns.Any(c => c.CasingColumn is null))
            {
                string name = $"p{parameters.Count}";
                parameters.Add(new QueryParameter(name, value));
                placeholder = $"${name}";
            }
            if (tagColumns.Any(c => c.CasingColumn is not null))
            {
                string name = $"p{parameters.Count}";
                parameters.Add(new QueryParameter(name, clause.Values[i]));
                encodedPlaceholder = $"lower(${name})";
            }
            string[] perColumn = new string[tagColumns.Count];
            for (int c = 0; c < tagColumns.Count; c++)
            {
                if (tagColumns[c].Kind == ColumnKind.List)
                {
                    perColumn[c] = ListElementContains(SqlText.QuoteIdentifier(tagColumns[c].Name), placeholder);
                }
                else
                {
                    string indexed = SearchColumn(tagColumns[c], schema);
                    bool encoded = tagColumns[c].CasingColumn is not null;
                    string scan = $"lower({SqlText.QuoteIdentifier(tagColumns[c].Name)})";
                    perColumn[c] = ScalarContains(MatchExpr(clause.Values[i], indexed, scan), encoded ? encodedPlaceholder : placeholder);
                }
            }
            valueMatches[i] = perColumn.Length == 1 ? perColumn[0] : $"({string.Join(" OR ", perColumn)})";
        }
        return Combine(clause, valueMatches);
    }

    internal static string BuildMergedTagComparisonTerm(
        IReadOnlyList<ColumnInfo> tagColumns,
        QueryClause clause,
        List<QueryParameter> parameters)
    {
        foreach (ColumnInfo column in tagColumns)
        {
            ComplexTypes.Validate(column);
        }
        if (tagColumns.Any(column => column.Kind == ColumnKind.Object))
        {
            throw new NonNumericComparisonException(TagsKeyword);
        }
        string[] valueMatches = new string[clause.Values.Count];
        for (int i = 0; i < clause.Values.Count; i++)
        {
            string value = clause.Values[i];
            string name = $"p{parameters.Count}";
            parameters.Add(new QueryParameter(name, value));
            string[] perColumn = [.. tagColumns.Select(column => ComparisonCheck(column, clause.Op, name, value))];
            valueMatches[i] = perColumn.Length == 1 ? perColumn[0] : $"({string.Join(" OR ", perColumn)})";
        }
        return $"({string.Join(" OR ", valueMatches)})";
    }

    private static string BuildComparisonTerm(ColumnInfo column, QueryClause clause, List<QueryParameter> parameters)
    {
        string[] checks = new string[clause.Values.Count];
        for (int i = 0; i < clause.Values.Count; i++)
        {
            string value = clause.Values[i];
            string name = $"p{parameters.Count}";
            parameters.Add(new QueryParameter(name, value));
            checks[i] = ComparisonCheck(column, clause.Op, name, value);
        }
        return $"({string.Join(" OR ", checks)})";
    }

    private static string ComparisonCheck(ColumnInfo column, MatchOp matchOp, string parameterName, string value)
    {
        bool atLeast = matchOp == MatchOp.GreaterOrEqual;
        string op = atLeast ? ">=" : "<=";
        string castType = column.IsNumeric && !string.IsNullOrEmpty(column.NumericType)
            ? column.NumericType
            : column.IsNumeric ? "DOUBLE" : "BIGINT";
        bool integral = !column.IsNumeric || DuckDbTypeMapper.IsIntegerType(castType);
        string bound = integral && !IsIntegerLiteral(value)
            ? $"TRY_CAST({(atLeast ? "CEIL" : "FLOOR")}(TRY_CAST(${parameterName} AS DOUBLE)) AS {castType})"
            : $"TRY_CAST(${parameterName} AS {castType})";
        string valueExpression = column.Kind == ColumnKind.List
            ? ArrayCount(SqlText.QuoteIdentifier(column.Name))
            : column.IsNumeric
            ? SqlText.QuoteIdentifier(column.Name)
            : $"length({SqlText.QuoteIdentifier(column.Name)})";
        return $"{valueExpression} {op} {bound}";
    }

    internal static string ArrayCount(string expression) => $"coalesce(list_count({expression}), 0)";

    internal static bool IsIntegerLiteral(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return false;
        }
        int start = value[0] is '+' or '-' ? 1 : 0;
        if (start == value.Length)
        {
            return false;
        }
        for (int i = start; i < value.Length; i++)
        {
            if (value[i] is < '0' or > '9')
            {
                return false;
            }
        }
        return true;
    }

    private static string BuildContainsTerm(ColumnInfo column, ColumnSchema schema, QueryClause clause, List<QueryParameter> parameters)
    {
        string indexed = SearchColumn(column, schema);
        bool encoded = column.CasingColumn is not null;
        // NGRAM retains only ASCII alphanumeric trigrams. Other needles need an exact scan.
        string scan = $"lower({SqlText.QuoteIdentifier(column.Name)})";
        string[] checks = new string[clause.Values.Count];
        for (int i = 0; i < clause.Values.Count; i++)
        {
            string value = MatchValue(clause.Values[i]);
            string name = $"p{parameters.Count}";
            parameters.Add(new QueryParameter(name, encoded ? clause.Values[i] : value));
            checks[i] = ScalarContains(MatchExpr(clause.Values[i], indexed, scan), encoded ? $"lower(${name})" : $"${name}");
        }
        return Combine(clause, checks);
    }

    private static string BuildListTerm(string column, QueryClause clause, List<QueryParameter> parameters)
    {
        string[] checks = new string[clause.Values.Count];
        for (int i = 0; i < clause.Values.Count; i++)
        {
            string name = $"p{parameters.Count}";
            parameters.Add(new QueryParameter(name, MatchValue(clause.Values[i])));
            checks[i] = ListElementContains(column, $"${name}");
        }
        return Combine(clause, checks);
    }

    private static string MatchValue(string value) => value.ToLowerInvariant();

    internal const int NgramMinLength = 3;
    internal static string MatchExpr(string value, string indexedExpr, string scanExpr)
        => value.Length >= NgramMinLength && value.All(IsAsciiAlphanumeric) ? indexedExpr : scanExpr;

    private static bool IsAsciiAlphanumeric(char value)
        => value is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9';

    /// <summary>
    /// Returns a necessary substring for candidate filtering, never a replacement for the exact predicate.
    /// Extract before lowercasing so Unicode case conversion cannot introduce an unverified ASCII run.
    /// </summary>
    internal static string NgramAnchor(string value)
    {
        int bestStart = 0, bestLength = 0, runStart = 0;
        for (int i = 0; i <= value.Length; i++)
        {
            if (i < value.Length && IsAsciiAlphanumeric(value[i]))
            {
                continue;
            }

            int length = i - runStart;
            if (length > bestLength)
            {
                bestStart = runStart;
                bestLength = length;
            }
            runStart = i + 1;
        }
        return bestLength >= NgramMinLength ? value.Substring(bestStart, bestLength).ToLowerInvariant() : null;
    }

    internal static string SearchColumn(ColumnInfo column, ColumnSchema schema)
    {
        if (column.CasingColumn is not null)
        {
            return SqlText.QuoteIdentifier(column.Name);
        }
        // Deprecated __lc storage remains readable.
        if (schema.TryGet(column.Name + ColumnSchema.CompanionSuffix, out ColumnInfo companion)
            && companion.Kind == ColumnKind.Scalar && companion.HasNgramIndex)
        {
            return SqlText.QuoteIdentifier(companion.Name);
        }
        if (column.HasNgramIndex)
        {
            return SqlText.QuoteIdentifier(column.Name);
        }
        return $"lower({SqlText.QuoteIdentifier(column.Name)})";
    }

    private static string ScalarContains(string searchColumn, string placeholder)
        => $"contains({searchColumn}, {placeholder})";

    private static string ListElementContains(string column, string placeholder)
        => $"len(list_filter({column}, x -> contains(lower(x), {placeholder}))) > 0";

    private static string Combine(QueryClause clause, IReadOnlyList<string> checks) => clause.Op switch
    {
        MatchOp.Any => $"({string.Join(" OR ", checks)})",
        MatchOp.All => $"({string.Join(" AND ", checks)})",
        MatchOp.None => $"NOT ({string.Join(" OR ", checks)})",
        _ => throw new QueryException($"Unsupported operator for column '{clause.Column}'."),
    };
}
