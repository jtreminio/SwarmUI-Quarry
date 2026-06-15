namespace Quarry;

// Resolves a dataset file path to the DuckDB FROM-clause expression that reads it, chosen by extension.
public sealed class DatasetSource
{
    public string FromExpression { get; }
    public bool RequiresLance { get; }

    private DatasetSource(string fromExpression, bool requiresLance)
    {
        FromExpression = fromExpression;
        RequiresLance = requiresLance;
    }

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

    public static bool IsSupported(string path) => SupportedExtensions.Contains(GetExtension(path));

    public static DatasetSource Resolve(string path)
    {
        string ext = GetExtension(path);
        string literal = SqlText.QuoteLiteral(path);
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
}
