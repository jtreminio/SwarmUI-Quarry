using System.Text.RegularExpressions;

namespace Quarry;

/// <summary>Reads DuckDB's schema type strings, retaining field order and quoted names.</summary>
public static class ComplexTypes
{
    public static IReadOnlyList<ColumnInfo> Fields(string type)
    {
        if (type is null)
        {
            return [];
        }

        string item = Regex.Replace(type.Trim(), @"\[\d*\]$", "");
        if (!item.StartsWith("STRUCT(", StringComparison.OrdinalIgnoreCase) || !item.EndsWith(')'))
        {
            return [];
        }

        List<ColumnInfo> fields = [];
        string body = item[7..^1];
        int depth = 0, start = 0;
        bool quoted = false;
        for (int i = 0; i <= body.Length; i++)
        {
            char c = i == body.Length ? ',' : body[i];
            if (c == '"')
            {
                if (quoted && i + 1 < body.Length && body[i + 1] == '"') { i++; continue; }
                quoted = !quoted;
            }
            if (quoted)
            {
                continue;
            }

            if (c == '(')
            {
                depth++;
            }

            if (c == ')')
            {
                depth--;
            }

            if (c != ',' || depth != 0)
            {
                continue;
            }

            string field = body[start..i].Trim();
            Match match = Regex.Match(field, "^(\"(?:[^\"]|\"\")*\"|[^ ]+)\\s+(.+)$");
            if (!match.Success)
            {
                throw new QueryException($"Cannot read object field '{field}'.");
            }

            string name = match.Groups[1].Value;
            if (name.StartsWith('"'))
            {
                name = name[1..^1].Replace("\"\"", "\"");
            }

            string fieldType = match.Groups[2].Value;
            bool numeric = DuckDbTypeMapper.IsNumeric(fieldType);
            fields.Add(new(name, DuckDbTypeMapper.MapKind(fieldType), numeric, numericType: numeric ? fieldType : null, dataType: fieldType));
            start = i + 1;
        }
        return fields;
    }

    public static void Validate(ColumnInfo column)
    {
        if (column.IsRecord && column.Fields.Any(f => f.Kind != ColumnKind.Scalar || IsUnsupported(f.DataType)))
        {
            throw new QueryException($"Column '{column.Name}' must contain direct scalar fields; nested objects and arrays inside records are not supported.");
        }

        if (!column.IsRecord && IsUnsupported(column.DataType))
        {
            throw new QueryException($"Column '{column.Name}' has unsupported nested data. Use a direct object or an array of direct objects.");
        }
    }

    private static bool IsUnsupported(string type) => type is not null &&
        (type.StartsWith("MAP(", StringComparison.OrdinalIgnoreCase)
        || type.StartsWith("UNION(", StringComparison.OrdinalIgnoreCase)
        || Regex.IsMatch(type, @"\[\d*\]\[\d*\]$"));
}

public sealed record FieldPath(ColumnInfo Column, string Selector = null, ColumnInfo Field = null)
{
    public bool IsAllRecords => Column.Kind == ColumnKind.List && Selector is null;
    public bool IsVariable => Selector is not null && !int.TryParse(Selector, out _);
    public string BindingKey => Column.Name + "\0" + Selector;

    public static FieldPath Resolve(string text, ColumnSchema schema)
    {
        if (schema.TryGet(text, out ColumnInfo exact))
        {
            ComplexTypes.Validate(exact);
            if (exact.IsCasingPatch || exact.IsSearchHelper)
            {
                throw new QueryException("Internal storage columns cannot be queried directly.");
            }

            return new(exact);
        }
        Match match = Regex.Match(text, @"^([^\[\].]+)(?:\[(\d+|\*|[a-zA-Z_][a-zA-Z_0-9]*|)\])?(?:\.([^\[\].]+))?$");
        if (!match.Success || !schema.TryGet(match.Groups[1].Value, out ColumnInfo column))
        {
            throw new QueryException($"Unknown field or invalid selector '{text}'.");
        }

        ComplexTypes.Validate(column);
        if (column.IsCasingPatch || column.IsSearchHelper)
        {
            throw new QueryException("Internal storage columns cannot be queried directly.");
        }

        string selector = match.Groups[2].Success ? match.Groups[2].Value : null;
        if (selector is not null && column.Kind != ColumnKind.List)
        {
            throw new QueryException($"Array selectors require an array column; '{column.Name}' is not an array.");
        }

        selector = selector is "" or "*" ? null : selector;
        if (!column.IsRecord && (column.Kind != ColumnKind.List || selector is not null || match.Groups[3].Success))
        {
            throw new QueryException($"Column '{column.Name}' is not an object or an array of objects.");
        }

        if (selector is not null && char.IsDigit(selector[0]) && !int.TryParse(selector, out _))
        {
            throw new QueryException($"Array index in '{text}' is too large.");
        }

        ColumnInfo field = null;
        if (match.Groups[3].Success)
        {
            field = column.Fields.FirstOrDefault(f => string.Equals(f.Name, match.Groups[3].Value, StringComparison.OrdinalIgnoreCase));
            if (field is null)
            {
                throw new QueryException($"Field '{match.Groups[3].Value}' does not exist in '{column.Name}'.");
            }
        }
        return new(column, selector, field);
    }
}
