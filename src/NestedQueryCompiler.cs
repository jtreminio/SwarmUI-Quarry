namespace Quarry;

public sealed record OutputPart(string Expression, string CasingColumn = null, string Label = null);
public sealed record NestedOutput(IReadOnlyList<OutputPart> Parts, OutputFormat Format);

/// <summary>Scalar binding subqueries keep assignments from multiplying source rows.</summary>
public static class NestedQueryCompiler
{
    // Match String.Trim/IsNullOrWhiteSpace used by the final renderer, including
    // tabs and Unicode separators. Prep's deduplication keeps its separate policy.
    private static readonly string OutputWhitespace = new(Enumerable.Range(0, char.MaxValue + 1)
        .Select(i => (char)i).Where(char.IsWhiteSpace).ToArray());
    private static string Q(string value) => SqlText.QuoteIdentifier(value);
    private static string L(string value) => SqlText.QuoteLiteral(value);
    private static string TrimOutput(string expression) => $"trim({expression}, {L(OutputWhitespace)})";

    public static SqlFilter Build(Query query, ColumnSchema schema, IReadOnlyList<ColumnInfo> tags, IReadOnlyList<string> outputs)
    {
        foreach (string name in outputs.Concat(query.Clauses.Select(c => c.Column)))
        {
            if (schema.TryGet(name, out ColumnInfo existing))
            {
                ComplexTypes.Validate(existing);
            }
        }

        bool complex = query.Clauses.Any(c => !schema.TryGet(c.Column, out ColumnInfo col) || col.Kind != ColumnKind.Scalar)
            || outputs.Any(c => !schema.TryGet(c, out ColumnInfo col) || col.Kind != ColumnKind.Scalar)
            || (query.Clauses.Any(c => c.Column.Equals("tags", StringComparison.OrdinalIgnoreCase)) && tags.Any(c => c.Kind != ColumnKind.Scalar))
            || query.Format != new OutputFormat();
        if (!complex)
        {
            return SqlFilterBuilder.Build(query, schema, tags);
        }

        Compiler compiler = new(query, schema, tags);
        return compiler.Build(outputs);
    }

    private sealed class Compiler(Query query, ColumnSchema schema, IReadOnlyList<ColumnInfo> tags)
    {
        private readonly List<QueryParameter> _parameters = [];
        private readonly List<FieldPath> _bindings = [];
        private readonly List<QueryParameter> _candidateParameters = [];
        private readonly HashSet<SearchHelper> _candidateHelpers = [];
        private string _assignment;

        private int Binding(FieldPath path) => _bindings.FindIndex(b => b.BindingKey == path.BindingKey);
        private string IndexName(int index) => Q($"__quarry_index_{index}");
        private string Parameter(string value)
        {
            string name = $"n{_parameters.Count}";
            _parameters.Add(new(name, value));
            return "$" + name;
        }

        public SqlFilter Build(IReadOnlyList<string> outputs)
        {
            List<(QueryClause Clause, FieldPath Path)> nested = [];
            List<QueryClause> plain = [];
            List<QueryClause> mergedTags = [];
            foreach (QueryClause clause in query.Clauses)
            {
                if (clause.Column.Equals("tags", StringComparison.OrdinalIgnoreCase) && tags.Count > 0
                    && tags.Any(t => t.Kind != ColumnKind.Scalar))
                { mergedTags.Add(clause); continue; }
                if ((clause.Column.Equals("tags", StringComparison.OrdinalIgnoreCase) && tags.Count > 0 && tags.All(t => t.Kind == ColumnKind.Scalar))
                    || (schema.TryGet(clause.Column, out ColumnInfo col) && col.Kind == ColumnKind.Scalar))
                { plain.Add(clause); continue; }
                FieldPath path = FieldPath.Resolve(clause.Column, schema);
                nested.Add((clause, path));
                if (path.IsVariable && Binding(path) < 0)
                {
                    _bindings.Add(path);
                }
            }
            SqlFilter scalar = SqlFilterBuilder.Build(new Query(query.Name, plain), schema, tags);
            _parameters.AddRange(scalar.Parameters);
            List<string> outer = scalar.IsEmpty ? [] : [scalar.WhereClause];
            foreach (QueryClause clause in mergedTags)
            {
                if (clause.Op is MatchOp.GreaterOrEqual or MatchOp.LessOrEqual)
                {
                    outer.Add(SqlFilterBuilder.BuildMergedTagComparisonTerm(tags, clause, _parameters));
                    continue;
                }

                List<string> matches = [];
                foreach (string value in clause.Values)
                {
                    List<string> columns = [];
                    foreach (ColumnInfo tag in tags)
                    {
                        ComplexTypes.Validate(tag);
                        if (tag.IsRecord)
                        {
                            columns.Add(Predicate(new(tag), new(tag.Name, MatchOp.Any, [value])));
                        }
                        else
                        {
                            string parameter = Parameter(value);
                            columns.Add(tag.Kind == ColumnKind.List
                                ? $"coalesce(len(list_filter({Q(tag.Name)}, x -> contains(lower(CAST(x AS VARCHAR)), lower({parameter})))) > 0, false)"
                                : $"coalesce(contains(lower(CAST({Q(tag.Name)} AS VARCHAR)), lower({parameter})), false)");
                        }
                    }
                    matches.Add($"({string.Join(" OR ", columns)})");
                }
                string combined = $"({string.Join(clause.Op == MatchOp.All ? " AND " : " OR ", matches)})";
                outer.Add(clause.Op == MatchOp.None ? "NOT " + combined : combined);
            }
            List<string> bound = [];
            // Plain clauses are already exact predicates and can retain their scalar
            // indexes when a query also selects or searches structured records.
            bool canUseCandidates = !schema.TryGet("_rowid", out _);
            List<string> candidates = scalar.IsEmpty || !canUseCandidates ? [] : [$"({scalar.WhereClause})"];
            foreach ((QueryClause clause, FieldPath path) in nested)
            {
                string predicate = Predicate(path, clause);
                (path.IsVariable ? bound : outer).Add(predicate);
                string candidate = canUseCandidates ? CandidatePredicate(path, clause) : null;
                if (candidate is not null)
                {
                    candidates.Add(candidate);
                }
            }
            if (_bindings.Count > 0)
            {
                foreach (FieldPath binding in _bindings)
                {
                    bound.Add($"{Record(binding)} IS NOT NULL");
                }

                for (int i = 0; i < _bindings.Count; i++)
                {
                    for (int j = 0; j < i; j++)
                    {
                        if (_bindings[i].Column.Name == _bindings[j].Column.Name)
                        {
                            bound.Add($"{IndexName(i)} <> {IndexName(j)}");
                        }
                    }
                }

                string from = string.Join(" CROSS JOIN ", _bindings.Select((b, i) =>
                    $"unnest(range(0, coalesce(len({Q(b.Column.Name)}), 0))) AS {Q($"__quarry_binding_{i}")}({IndexName(i)})"));
                string fields = string.Join(", ", _bindings.Select((_, i) => $"v{i} := {IndexName(i)}"));
                string order = string.Join(", ", _bindings.Select((_, i) => IndexName(i)));
                _assignment = $"(SELECT struct_pack({fields}) FROM {from} WHERE {string.Join(" AND ", bound)} ORDER BY {order} LIMIT 1)";
                outer.Add($"{_assignment} IS NOT NULL");
            }
            List<OutputPart> parts = [];
            foreach (string output in outputs)
            {
                FieldPath path = FieldPath.Resolve(output, schema);
                if (path.IsVariable && Binding(path) < 0)
                {
                    throw new QueryException($"Output variable '{output}' is not bound by a filter.");
                }

                string expression = Render(path);
                string patch = path.Column.IsRecord ? null : path.Column.CasingColumn;
                string label = query.Format.Keys && !path.Column.IsRecord ? path.Column.Name : null;
                parts.Add(new(expression, patch, label));
            }
            // Exclude missing indices and blank selections before counting or sampling.
            string content = $"concat_ws('', {string.Join(", ", parts.Select(p => p.Expression))})";
            outer.Add($"length({TrimOutput(content)}) > 0");
            string ordinal = "__quarry_source_ordinal";
            while (schema.TryGet(ordinal, out _))
            {
                ordinal += "_";
            }

            return new(string.Join(" AND ", outer.Select(s => $"({s})")), _parameters, new(parts, query.Format),
                string.Join(" AND ", candidates), _candidateParameters, [.. _candidateHelpers], ordinal,
                nested.Count > 0 || mergedTags.Count > 0 || outputs.Any(o => FieldPath.Resolve(o, schema).Column.Kind != ColumnKind.Scalar));
        }

        // Helpers combine all records. They can only narrow positive predicates;
        // same-record identity, indices, distinctness and the full needle stay in Predicate.
        private string CandidatePredicate(FieldPath path, QueryClause clause)
        {
            if (clause.Op is not (MatchOp.Any or MatchOp.All))
            {
                return null;
            }

            IReadOnlyList<ColumnInfo> fields = path.Field is null ? path.Column.Fields : [path.Field];
            List<SearchHelper> helpers = [];
            foreach (ColumnInfo field in fields)
            {
                // A whole-record OR cannot restrict away an unindexed field's matches.
                SearchHelper helper = schema.SearchHelpers.FirstOrDefault(h =>
                    string.Equals(h.Column, path.Column.Name, StringComparison.OrdinalIgnoreCase)
                    && string.Equals(h.Field, field.Name, StringComparison.OrdinalIgnoreCase));
                if (helper is null)
                {
                    return null;
                }

                helpers.Add(helper);
            }
            if (helpers.Count == 0)
            {
                return null;
            }

            string[] anchors = [.. clause.Values.Select(SqlFilterBuilder.NgramAnchor)];
            if (clause.Op == MatchOp.Any && anchors.Any(a => a is null))
            {
                return null;
            }

            List<string> checks = [];
            foreach (string anchor in anchors.Where(a => a is not null))
            {
                string name = $"c{_candidateParameters.Count}";
                _candidateParameters.Add(new(name, anchor));
                checks.Add("(" + string.Join(" OR ", helpers.Select(h => $"contains({Q(h.Physical)}, ${name})")) + ")");
            }
            if (checks.Count == 0)
            {
                return null;
            }

            foreach (SearchHelper helper in helpers)
            {
                _candidateHelpers.Add(helper);
            }

            return "(" + string.Join(clause.Op == MatchOp.All ? " AND " : " OR ", checks) + ")";
        }

        private string Record(FieldPath path, bool output = false)
        {
            string col = Q(path.Column.Name);
            if (path.Column.Kind != ColumnKind.List)
            {
                return col;
            }

            string index = path.IsVariable
                ? output ? $"({_assignment}).v{Binding(path)}" : IndexName(Binding(path))
                : path.Selector ?? "0";
            return $"({col})[CAST({index} AS BIGINT) + 1]";
        }

        private static string Field(string record, ColumnInfo field) => $"({record}).{Q(field.Name)}";
        private string Values(FieldPath path, string record) => !path.Column.IsRecord
            ? $"[CAST({record} AS VARCHAR)]"
            : path.Field is not null
            ? $"[CAST({Field(record, path.Field)} AS VARCHAR)]"
            : $"[{string.Join(", ", path.Column.Fields.Select(f => $"CAST({Field(record, f)} AS VARCHAR)"))}]";

        private string Predicate(FieldPath path, QueryClause clause)
        {
            if (clause.Op is MatchOp.GreaterOrEqual or MatchOp.LessOrEqual)
            {
                bool arrayCount = path.IsAllRecords && path.Field is null;
                if (!arrayCount && (path.Field is null || path.IsAllRecords))
                {
                    throw new QueryException("Comparisons require an array column for record counts or a single scalar field for numbers/text length.");
                }

                bool numeric = !arrayCount && path.Field.IsNumeric;
                string field = arrayCount ? null : Field(Record(path), path.Field);
                string val = arrayCount ? SqlFilterBuilder.ArrayCount(Q(path.Column.Name))
                    : numeric ? field : $"length(CAST({field} AS VARCHAR))";
                string op = clause.Op == MatchOp.GreaterOrEqual ? ">=" : "<=";
                string type = numeric ? path.Field.NumericType : "BIGINT";
                bool integral = !numeric || DuckDbTypeMapper.IsIntegerType(type);
                return "(" + string.Join(" OR ", clause.Values.Select(v =>
                {
                    string p = Parameter(v);
                    string bound = integral && !SqlFilterBuilder.IsIntegerLiteral(v)
                        ? $"TRY_CAST({(op == ">=" ? "ceil" : "floor")}(TRY_CAST({p} AS DOUBLE)) AS {type})"
                        : $"TRY_CAST({p} AS {type})";
                    return $"coalesce({val} {op} {bound}, false)";
                })) + ")";
            }
            string values = path.IsAllRecords
                ? $"flatten(list_transform({Q(path.Column.Name)}, __quarry_record -> {Values(path, "__quarry_record")}))"
                : Values(path, Record(path));
            string[] checks = [.. clause.Values.Select(v =>
                $"coalesce(len(list_filter({values}, __quarry_value -> contains(lower(__quarry_value), lower({Parameter(v)})))) > 0, false)")];
            string joined = string.Join(clause.Op == MatchOp.All ? " AND " : " OR ", checks);
            return clause.Op == MatchOp.None ? $"NOT ({joined})" : $"({joined})";
        }

        private string Cell(string expression, string label = null)
        {
            string value = $"nullif({TrimOutput($"CAST({expression} AS VARCHAR)")}, '')";
            return query.Format.Keys && label is not null ? $"({L(label + ": ")} || {value})" : value;
        }

        private string RenderRecord(FieldPath path, string record)
        {
            if (path.Field is not null)
            {
                return Cell(Field(record, path.Field), path.Field.Name);
            }

            return $"nullif(concat_ws({L(query.Format.FieldSeparator)}, {string.Join(", ", path.Column.Fields.Select(f => Cell(Field(record, f), f.Name)))}), '')";
        }

        private string Render(FieldPath path)
        {
            if (!path.Column.IsRecord)
            {
                string col = Q(path.Column.Name);
                // Casing patches address byte offsets in the original untrimmed value.
                if (path.Column.CasingColumn is not null)
                {
                    return col;
                }

                if (path.Column.Kind == ColumnKind.List)
                {
                    return $"nullif(array_to_string(list_filter(list_transform({col}, __quarry_value -> {Cell("__quarry_value")}), __quarry_text -> __quarry_text IS NOT NULL), {L(query.Format.FieldSeparator)}), '')";
                }

                return Cell(col);
            }
            if (path.IsAllRecords)
            {
                return $"nullif(array_to_string(list_filter(list_transform({Q(path.Column.Name)}, __quarry_record -> {RenderRecord(path, "__quarry_record")}), __quarry_text -> __quarry_text IS NOT NULL), {L(query.Format.RecordSeparator)}), '')";
            }

            return RenderRecord(path, Record(path, output: true));
        }
    }
}
