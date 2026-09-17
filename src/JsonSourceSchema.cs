using System.Globalization;
using System.IO;
using System.Numerics;
using System.Text.Json;

namespace Quarry;

/// <summary>Complete, bounded-memory discovery prevents JSON inference from changing logical values.</summary>
internal static class JsonSourceSchema
{
    private readonly record struct Identity(long Length, long Modified, long Created);
    private sealed record Cached(Identity Identity, string Expression);
    private static readonly Dictionary<string, Cached> Cache = new(StringComparer.Ordinal);
    private static readonly object CacheLock = new();

    internal static string Resolve(string path, bool newlineDelimited)
    {
        path = Path.GetFullPath(path);
        lock (CacheLock)
        {
            for (int attempt = 0; attempt < 2; attempt++)
            {
                Identity before = Identify(path);
                if (Cache.TryGetValue(path, out Cached cached) && cached.Identity == before)
                {
                    return cached.Expression;
                }

                string expression = Discover(path, newlineDelimited);
                if (Identify(path) != before)
                {
                    continue;
                }
                // Keep one entry per file, with a bounded cache for long-running servers.
                if (Cache.Count >= 256)
                {
                    Cache.Clear();
                }

                Cache[path] = new(before, expression);
                return expression;
            }
        }
        throw new QueryException($"JSON dataset '{path}' changed during schema discovery. Retry after the file finishes updating.");
    }

    private static Identity Identify(string path)
    {
        FileInfo file = new(path);
        if (!file.Exists)
        {
            throw new QueryException($"JSON dataset '{path}' does not exist.");
        }

        return new(file.Length, file.LastWriteTimeUtc.Ticks, file.CreationTimeUtc.Ticks);
    }

    private static string Discover(string path, bool newlineDelimited)
    {
        Node root = new();
        long row = 0;
        try
        {
            foreach (JsonElement record in Records(path, newlineDelimited))
            {
                row++;
                if (record.ValueKind != JsonValueKind.Object)
                {
                    throw Invalid("$", "each dataset row must be a JSON object");
                }

                root.Observe(record, "$", -1);
            }
        }
        catch (JsonException ex)
        {
            throw new QueryException($"Invalid JSON in '{path}' near row {row + 1}: {ex.Message}");
        }
        if (root.Fields.Count == 0)
        {
            throw new QueryException($"JSON dataset '{path}' contains no fields. Supply rows with named columns.");
        }

        List<string> columns = [], projections = [];
        bool emptyPrompt = false;
        foreach ((string name, Node field) in root.Fields)
        {
            if (field.IsSchemaLessComplex)
            {
                if (!name.Equals("prompt", StringComparison.OrdinalIgnoreCase))
                {
                    throw Invalid(name, "contains only empty objects/lists/null slots; omit this column or provide a record defining its fields");
                }

                columns.Add($"{SqlText.QuoteLiteral(name)}: 'JSON'");
                projections.Add($"CAST(NULL AS VARCHAR) AS {SqlText.QuoteIdentifier(name)}");
                emptyPrompt = true;
            }
            else
            {
                columns.Add($"{SqlText.QuoteLiteral(name)}: {SqlText.QuoteLiteral(field.Type(name))}");
                projections.Add(SqlText.QuoteIdentifier(name));
            }
        }
        string reader = newlineDelimited ? "read_ndjson" : "read_json";
        string source = $"{reader}({SqlText.QuoteLiteral(path)}, columns = {{{string.Join(", ", columns)}}}, auto_detect = false)";
        return emptyPrompt ? $"(SELECT {string.Join(", ", projections)} FROM {source} WHERE false)" : source;
    }

    private static IEnumerable<JsonElement> Records(string path, bool newlineDelimited)
    {
        if (newlineDelimited)
        {
            using StreamReader reader = new(path);
            while (reader.ReadLine() is string line)
            {
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                using JsonDocument document = JsonDocument.Parse(line);
                yield return document.RootElement;
            }
            yield break;
        }
        // Deserialize one array member at a time. A single object is itself one bounded row.
        using FileStream stream = File.OpenRead(path);
        using (StreamReader sniff = new(stream, leaveOpen: true))
        {
            int first;
            do { first = sniff.Read(); } while (first >= 0 && char.IsWhiteSpace((char)first));
            stream.Position = 0;
            if (first != '[')
            {
                using JsonDocument document = JsonDocument.Parse(stream);
                yield return document.RootElement;
                yield break;
            }
        }
        IAsyncEnumerator<JsonElement> records = JsonSerializer.DeserializeAsyncEnumerable<JsonElement>(stream).GetAsyncEnumerator();
        try
        {
            while (records.MoveNextAsync().AsTask().GetAwaiter().GetResult())
            {
                yield return records.Current;
            }
        }
        finally { records.DisposeAsync().AsTask().GetAwaiter().GetResult(); }
    }

    private static QueryException Invalid(string path, string reason)
        => new($"Unsupported JSON field '{path}': {reason}.");

    private enum Kind { Unknown, Text, Boolean, Integer, Float, Object, Array }

    private sealed class Node
    {
        private Kind _kind;
        private BigInteger _minimum, _maximum;
        private Node _element;
        public Dictionary<string, Node> Fields { get; } = new(StringComparer.Ordinal);
        private readonly Dictionary<string, string> _names = new(StringComparer.OrdinalIgnoreCase);

        public bool IsSchemaLessComplex => _kind == Kind.Object && Fields.Count == 0
            || _kind == Kind.Array && _element.IsSchemaLessComplex;

        public void Observe(JsonElement value, string path, int depth)
        {
            if (value.ValueKind == JsonValueKind.Null)
            {
                return;
            }

            string raw = value.ValueKind == JsonValueKind.Number ? value.GetRawText() : null;
            Kind kind = value.ValueKind switch
            {
                JsonValueKind.String => Kind.Text,
                JsonValueKind.True or JsonValueKind.False => Kind.Boolean,
                JsonValueKind.Number => raw.IndexOfAny(['.', 'e', 'E']) < 0 ? Kind.Integer : Kind.Float,
                JsonValueKind.Object => Kind.Object,
                JsonValueKind.Array => Kind.Array,
                _ => throw Invalid(path, "unsupported scalar kind"),
            };
            if (depth > 1 && kind is Kind.Object or Kind.Array || depth == 1 && kind == Kind.Array)
            {
                throw Invalid(path, "nested arrays/objects inside a record are not supported; use direct scalar fields");
            }

            if (_kind != Kind.Unknown && _kind != kind)
            {
                throw Invalid(path, $"mixed {_kind.ToString().ToLowerInvariant()} and {kind.ToString().ToLowerInvariant()} values; use one scalar kind and shape consistently");
            }

            bool first = _kind == Kind.Unknown;
            _kind = kind;
            switch (kind)
            {
                case Kind.Integer:
                    BigInteger integer = BigInteger.Parse(raw, CultureInfo.InvariantCulture);
                    if (first)
                    {
                        _minimum = _maximum = integer;
                    }
                    else { _minimum = BigInteger.Min(_minimum, integer); _maximum = BigInteger.Max(_maximum, integer); }
                    if (_minimum < long.MinValue || _maximum > ulong.MaxValue || _minimum < 0 && _maximum > long.MaxValue)
                    {
                        throw Invalid(path, "integer values cannot be represented losslessly by one signed or unsigned 64-bit integer type");
                    }

                    break;
                case Kind.Float:
                    if (!value.TryGetDouble(out double number) || !double.IsFinite(number))
                    {
                        throw Invalid(path, "number is outside the finite double-precision range");
                    }

                    break;
                case Kind.Object:
                    HashSet<string> seen = new(StringComparer.OrdinalIgnoreCase);
                    foreach (JsonProperty property in value.EnumerateObject())
                    {
                        string childPath = path == "$" ? property.Name : path + "." + property.Name;
                        if (!seen.Add(property.Name))
                        {
                            throw Invalid(childPath, "duplicate field names, including names differing only by case, are ambiguous");
                        }

                        if (_names.TryGetValue(property.Name, out string original) && original != property.Name)
                        {
                            throw Invalid(childPath, $"field name conflicts with '{original}' when compared without case");
                        }

                        if (!Fields.TryGetValue(property.Name, out Node child))
                        {
                            _names[property.Name] = property.Name;
                            Fields[property.Name] = child = new();
                        }
                        child.Observe(property.Value, childPath, depth < 0 ? 0 : 2);
                    }
                    break;
                case Kind.Array:
                    _element ??= new();
                    foreach (JsonElement element in value.EnumerateArray())
                    {
                        _element.Observe(element, path + "[]", depth + 1);
                    }

                    break;
            }
        }

        public string Type(string path) => _kind switch
        {
            Kind.Unknown or Kind.Text => "VARCHAR",
            Kind.Boolean => "BOOLEAN",
            Kind.Integer => _maximum > long.MaxValue ? "UBIGINT" : "BIGINT",
            Kind.Float => "DOUBLE",
            Kind.Array => _element.Type(path + "[]") + "[]",
            Kind.Object when Fields.Count > 0 => "STRUCT(" + string.Join(", ", Fields.Select(field =>
                SqlText.QuoteIdentifier(field.Key) + " " + field.Value.Type(path + "." + field.Key))) + ")",
            _ => throw Invalid(path, "no object fields were found"),
        };
    }
}
