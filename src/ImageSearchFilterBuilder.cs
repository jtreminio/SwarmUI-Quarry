using System.Globalization;
using Newtonsoft.Json.Linq;

namespace Quarry;

public sealed record ImageSearchOperator(string Value, string Label);

public static class ImageSearchFilterBuilder
{
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<ImageSearchOperator>> OperatorsByType =
        new Dictionary<string, IReadOnlyList<ImageSearchOperator>>(StringComparer.OrdinalIgnoreCase)
        {
            ["text"] = [new("contains", "contains"), new("equals", "is"), new("not_contains", "doesn't contain"), new("ne", "≠")],
            ["number"] = [new("eq", "="), new("ne", "≠"), new("gt", ">"), new("lt", "<"), new("ge", "≥"), new("le", "≤")],
            ["list"] = [new("contains", "contains"), new("not_contains", "doesn't contain")],
            ["bool"] = [new("is_true", "is set"), new("is_false", "is not set")],
            ["discovered"] =
            [
                new("contains", "contains"), new("equals", "is"), new("not_contains", "doesn't contain"),
                new("eq", "="), new("ne", "≠"), new("gt", ">"), new("lt", "<"), new("le", "≤"), new("ge", "≥"),
            ],
        };

    public static SqlFilter Build(JArray filters)
    {
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
            string term = BuildTerm(field.Trim(), op.Trim(), value, parameters);
            if (term is not null)
            {
                terms.Add(term);
            }
        }
        return terms.Count == 0 ? SqlFilter.None : new SqlFilter(string.Join(" AND ", terms), parameters);
    }

    private static string BuildTerm(string field, string op, string value, List<QueryParameter> parameters)
    {
        if (ImageHistoryIndex.CoreFieldTypes.TryGetValue(field, out ImageFieldType type))
        {
            string column = SqlText.QuoteIdentifier(field);
            return type switch
            {
                ImageFieldType.Text => TextTerm(column, op, value, parameters),
                ImageFieldType.Number => NumberTerm(column, op, value, parameters),
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
            : TextTerm(textExpr, op, value, parameters);
    }

    private static string TextTerm(string expr, string op, string value, List<QueryParameter> parameters)
    {
        string template = op switch
        {
            "contains" => "contains(lower({0}), lower({1}))",
            "equals" or "eq" => "lower({0}) = lower({1})",
            "ne" => "lower({0}) != lower({1})",
            "not_contains" => "NOT contains(lower({0}), lower({1}))",
            _ => null,
        };
        if (template is null)
        {
            return null;
        }
        return string.Format(template, expr, AddParam(parameters, value));
    }

    private static string NumberTerm(string expr, string op, string value, List<QueryParameter> parameters)
    {
        string comparison = op switch
        {
            "eq" => "=",
            "ne" => "!=",
            "gt" => ">",
            "lt" => "<",
            "ge" => ">=",
            "le" => "<=",
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
        if (op is not ("contains" or "not_contains"))
        {
            return null;
        }
        string contains = $"len(list_filter({column}, x -> contains(lower(x), lower({AddParam(parameters, value)})))) > 0";
        return op == "contains" ? contains : $"NOT ({contains})";
    }

    private static string BoolTerm(string column, string op) => op switch
    {
        "is_true" or "true" or "eq" => $"{column} = TRUE",
        "is_false" or "false" or "ne" => $"{column} IS NOT TRUE",
        _ => null,
    };

    private static bool IsNumericOp(string op) => op is "eq" or "ne" or "gt" or "lt" or "ge" or "le";

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
