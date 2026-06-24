using System.Globalization;
using Newtonsoft.Json.Linq;

namespace Quarry;

public sealed record ImageSearchOperator(string Value, string Label);

public static class ImageSearchFilterBuilder
{
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<ImageSearchOperator>> OperatorsByType =
        new Dictionary<string, IReadOnlyList<ImageSearchOperator>>(StringComparer.OrdinalIgnoreCase)
        {
            ["text"] = [new("=", "="), new("==", "=="), new("!=", "!=")],
            ["number"] = [new("=", "="), new("==", "=="), new("!=", "!="), new("+=", "+="), new("-=", "-=")],
            ["list"] = [new("=", "="), new("==", "=="), new("!=", "!=")],
            ["bool"] = [new("is_true", "is set"), new("is_false", "is not set")],
            ["discovered"] = [new("=", "="), new("==", "=="), new("!=", "!="), new("+=", "+="), new("-=", "-=")],
        };

    public static SqlFilter Build(JArray filters) => Build(filters, null, out _);

    public static SqlFilter Build(JArray filters, ColumnSchema schema) => Build(filters, schema, out _);

    public static SqlFilter Build(JArray filters, ColumnSchema schema, out List<string> warnings)
    {
        warnings = [];
        if (filters is null || filters.Count == 0)
        {
            return SqlFilter.None;
        }
        List<string> terms = [];
        List<QueryParameter> parameters = [];
        foreach (JToken token in filters)
        {
            if (token is not JObject row)
            {
                continue;
            }
            string field = row.Value<string>("field");
            string op = row.Value<string>("op");
            string value = row.Value<string>("value") ?? "";
            if (string.IsNullOrWhiteSpace(field) || string.IsNullOrWhiteSpace(op))
            {
                continue;
            }
            string term = BuildTerm(field.Trim(), op.Trim(), value, parameters, schema, warnings);
            if (term is not null)
            {
                terms.Add(term);
            }
        }
        return terms.Count == 0 ? SqlFilter.None : new SqlFilter(string.Join(" AND ", terms), parameters);
    }

    private static string BuildTerm(string field, string op, string value, List<QueryParameter> parameters, ColumnSchema schema, List<string> warnings)
    {
        if (ImageHistoryIndex.CoreFieldTypes.TryGetValue(field, out ImageFieldType type))
        {
            if (op is "+=" or "-=" && type != ImageFieldType.Number)
            {
                warnings.Add($"The “{op}” filter only works on number fields, so it was skipped for “{FieldLabel(field)}”.");
                return null;
            }
            string column = SqlText.QuoteIdentifier(field);
            return type switch
            {
                ImageFieldType.Text => TextTerm(v => TextMatchColumn(field, v, schema), op, value, parameters),
                ImageFieldType.Number => NumberFieldTerm(column, op, value, parameters),
                ImageFieldType.List => ListTerm(column, op, value, parameters),
                ImageFieldType.Bool => BoolTerm(column, op),
                _ => null,
            };
        }
        string path = JsonPath(field);
        if (path is null)
        {
            return null;
        }
        string textExpr = $"json_extract_string({SqlText.QuoteIdentifier(ImageHistoryIndex.MetaJsonColumn)}, {path})";
        return IsNumericOp(op)
            ? NumberTerm($"TRY_CAST({textExpr} AS DOUBLE)", op, value, parameters)
            : TextTerm(_ => $"lower({textExpr})", op, value, parameters);
    }

    private static string TextMatchColumn(string field, string value, ColumnSchema schema)
    {
        string scan = $"lower({SqlText.QuoteIdentifier(field)})";
        if (value.Length < SqlFilterBuilder.NgramMinLength)
        {
            return scan;
        }
        return schema is not null && schema.TryGet(field, out ColumnInfo column)
            ? SqlFilterBuilder.SearchColumn(column, schema)
            : scan;
    }

    private static string TextTerm(Func<string, string> matchColumnFor, string op, string value, List<QueryParameter> parameters)
    {
        if (op is not ("=" or "==" or "!="))
        {
            return null;
        }
        List<string> values = SplitValues(value);
        if (values.Count == 0)
        {
            return null;
        }
        string[] checks = new string[values.Count];
        for (int i = 0; i < values.Count; i++)
        {
            string p = AddParam(parameters, values[i].ToLowerInvariant());
            checks[i] = $"contains({matchColumnFor(values[i])}, {p})";
        }
        return Combine(op, checks);
    }

    private static string NumberFieldTerm(string column, string op, string value, List<QueryParameter> parameters)
        => op is "+=" or "-="
            ? NumberTerm(column, op, value, parameters)
            : TextTerm(_ => $"lower(CAST({column} AS VARCHAR))", op, value, parameters);

    private static string NumberTerm(string expr, string op, string value, List<QueryParameter> parameters)
    {
        string comparison = op switch
        {
            "+=" => ">=",
            "-=" => "<=",
            _ => null,
        };
        if (comparison is null)
        {
            return null;
        }
        if (!double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out _))
        {
            return null;
        }
        return $"{expr} {comparison} CAST({AddParam(parameters, value)} AS DOUBLE)";
    }

    private static string ListTerm(string column, string op, string value, List<QueryParameter> parameters)
    {
        if (op is not ("=" or "==" or "!="))
        {
            return null;
        }
        List<string> values = SplitValues(value);
        if (values.Count == 0)
        {
            return null;
        }
        string[] checks = new string[values.Count];
        for (int i = 0; i < values.Count; i++)
        {
            string p = AddParam(parameters, values[i].ToLowerInvariant());
            checks[i] = $"len(list_filter({column}, x -> contains(lower(x), {p}))) > 0";
        }
        return Combine(op, checks);
    }

    private static string Combine(string op, string[] checks)
    {
        if (op == "!=")
        {
            return checks.Length == 1 ? $"NOT {checks[0]}" : $"NOT ({string.Join(" OR ", checks)})";
        }
        if (checks.Length == 1)
        {
            return checks[0];
        }
        string separator = op == "==" ? " AND " : " OR ";
        return $"({string.Join(separator, checks)})";
    }

    private static List<string> SplitValues(string value)
    {
        List<string> values = [];
        foreach (string part in value.Split(','))
        {
            string trimmed = part.Trim();
            if (trimmed.Length > 0)
            {
                values.Add(trimmed);
            }
        }
        return values;
    }

    private static string BoolTerm(string column, string op) => op switch
    {
        "is_true" => $"{column} = TRUE",
        "is_false" => $"{column} IS NOT TRUE",
        _ => null,
    };

    private static bool IsNumericOp(string op) => op is "+=" or "-=";

    private static string FieldLabel(string field)
        => ImageHistoryIndex.CoreFields
            .FirstOrDefault(f => string.Equals(f.Column, field, StringComparison.OrdinalIgnoreCase))?.Label ?? field;

    private static string JsonPath(string field)
    {
        if (string.IsNullOrEmpty(field))
        {
            return null;
        }
        string escaped = field.Replace("\\", "\\\\").Replace("\"", "\\\"");
        return SqlText.QuoteLiteral($"$.\"{escaped}\"");
    }

    private static string AddParam(List<QueryParameter> parameters, string value)
    {
        string name = $"p{parameters.Count}";
        parameters.Add(new QueryParameter(name, value));
        return $"${name}";
    }
}
