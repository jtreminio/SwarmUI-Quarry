namespace Quarry;

/// <summary>Resolves a dataset file path to the DuckDB FROM-clause expression that reads it, chosen by
/// file extension. DuckDB reads CSV/TSV/JSON/JSONL/Parquet natively; Lance needs the lance extension.
/// Pure and side-effect free.</summary>
public sealed class DatasetSource
{
    /// <summary>The FROM-clause expression, e.g. <c>read_parquet('/path/x.parquet')</c> or, for Lance,
    /// the quoted path literal that the lance extension's replacement scan resolves.</summary>
    public string FromExpression { get; }

    /// <summary>True when reading this source requires the DuckDB <c>lance</c> extension to be loaded.</summary>
    public bool RequiresLance { get; }

    private DatasetSource(string fromExpression, bool requiresLance)
    {
        FromExpression = fromExpression;
        RequiresLance = requiresLance;
    }

    /// <summary>File extensions this extension can serve as wildcards (lowercase, with leading dot).</summary>
    public static readonly IReadOnlySet<string> SupportedExtensions =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".parquet",
            ".csv",
            ".tsv",
            ".json",
            ".jsonl",
            ".ndjson",
            ".lance",
        };

    /// <summary>Whether the file at <paramref name="path"/> is a type this extension can read.</summary>
    public static bool IsSupported(string path) => SupportedExtensions.Contains(GetExtension(path));

    /// <summary>Maps <paramref name="path"/> to its DuckDB reader. Throws for unsupported file types.</summary>
    public static DatasetSource Resolve(string path)
    {
        string ext = GetExtension(path);
        string literal = QuoteLiteral(path);
        return ext switch
        {
            ".parquet" => new DatasetSource($"read_parquet({literal})", false),
            ".csv" or ".tsv" => new DatasetSource($"read_csv({literal})", false),
            ".json" => new DatasetSource($"read_json({literal})", false),
            ".jsonl" or ".ndjson" => new DatasetSource($"read_ndjson({literal})", false),
            ".lance" => new DatasetSource(literal, true),
            _ => throw new WildcardQueryException($"Unsupported dataset file type '{ext}' for '{path}'."),
        };
    }

    private static string GetExtension(string path) => System.IO.Path.GetExtension(path).ToLowerInvariant();

    /// <summary>Single-quotes a path string literal, escaping embedded quotes by doubling.</summary>
    private static string QuoteLiteral(string path) => $"'{path.Replace("'", "''")}'";
}
