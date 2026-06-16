using System.IO;

namespace Quarry;

public enum ImageFieldType
{
    Text,
    Number,
    List,
    Bool,
}

public sealed record ImageSearchField(string Column, string Label, ImageFieldType Type, bool Discovered);

public static class ImageHistoryIndex
{
    public const string SubFolder = ".image-history";
    public const string IndexFileName = "quarry_index.lance";
    public const string TableName = "quarry_index";
    public const string MetaJsonColumn = "meta_json";
    public const string FullMetadataColumn = "full_metadata";
    public const string PathColumn = "path";

    private static readonly (string Name, string DdlType)[] Schema =
    [
        ("file_hash", "VARCHAR"),
        ("path", "VARCHAR"),
        ("mtime", "BIGINT"),
        ("is_starred", "BOOLEAN"),
        ("indexed_at", "BIGINT"),
        ("prompt", "VARCHAR"),
        ("negativeprompt", "VARCHAR"),
        ("original_prompt", "VARCHAR"),
        ("model", "VARCHAR"),
        ("seed", "BIGINT"),
        ("steps", "BIGINT"),
        ("cfgscale", "DOUBLE"),
        ("sampler", "VARCHAR"),
        ("width", "BIGINT"),
        ("height", "BIGINT"),
        ("loras", "VARCHAR[]"),
        ("embeddings", "VARCHAR[]"),
        (MetaJsonColumn, "VARCHAR"),
        (FullMetadataColumn, "VARCHAR"),
    ];

    public static readonly IReadOnlySet<string> PromotedParamKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "prompt", "negativeprompt", "model", "seed", "steps", "cfgscale", "sampler", "width", "height", "loras",
    };

    public static readonly IReadOnlyList<ImageSearchField> CoreFields =
    [
        new("prompt", "Prompt", ImageFieldType.Text, false),
        new("negativeprompt", "Negative prompt", ImageFieldType.Text, false),
        new("original_prompt", "Original prompt", ImageFieldType.Text, false),
        new("model", "Model", ImageFieldType.Text, false),
        new("loras", "LoRAs", ImageFieldType.List, false),
        new("embeddings", "Embeddings", ImageFieldType.List, false),
        new("steps", "Steps", ImageFieldType.Number, false),
        new("cfgscale", "CFG scale", ImageFieldType.Number, false),
        new("sampler", "Sampler", ImageFieldType.Text, false),
        new("seed", "Seed", ImageFieldType.Number, false),
        new("width", "Width", ImageFieldType.Number, false),
        new("height", "Height", ImageFieldType.Number, false),
        new("is_starred", "Starred", ImageFieldType.Bool, false),
    ];

    public static readonly IReadOnlyDictionary<string, ImageFieldType> CoreFieldTypes =
        CoreFields.ToDictionary(f => f.Column, f => f.Type, StringComparer.OrdinalIgnoreCase);

    private static readonly string ColumnNames = string.Join(", ", Schema.Select(c => c.Name));

    private static readonly string ReadJsonColumnsSpec =
        "{" + string.Join(", ", Schema.Select(c => $"{c.Name}: '{c.DdlType}'")) + "}";

    public static readonly IReadOnlyList<string> ResultColumns =
        [.. Schema.Select(c => c.Name).Where(n => n != MetaJsonColumn)];

    public static string CreateTableSql(string tableRef)
        => $"CREATE TABLE {tableRef} ({string.Join(", ", Schema.Select(c => $"{c.Name} {c.DdlType}"))});";

    public static string MergeUpsertSql(string tableRef, string stagingJsonLiteral)
    {
        string setList = string.Join(", ", Schema.Where(c => c.Name != PathColumn).Select(c => $"{c.Name} = s.{c.Name}"));
        string valList = string.Join(", ", Schema.Select(c => $"s.{c.Name}"));
        return $"MERGE INTO {tableRef} AS t "
            + $"USING (SELECT {ColumnNames} FROM read_json({stagingJsonLiteral}, format='array', columns={ReadJsonColumnsSpec})) AS s "
            + $"ON t.{PathColumn} = s.{PathColumn} "
            + $"WHEN MATCHED THEN UPDATE SET {setList} "
            + $"WHEN NOT MATCHED THEN INSERT ({ColumnNames}) VALUES ({valList});";
    }

    public static string MergePruneSql(string tableRef, string livePathsJsonLiteral)
        => $"MERGE INTO {tableRef} AS t "
            + $"USING (SELECT {PathColumn} FROM read_json({livePathsJsonLiteral}, format='array', columns={{{PathColumn}: 'VARCHAR'}})) AS s "
            + $"ON t.{PathColumn} = s.{PathColumn} "
            + "WHEN NOT MATCHED BY SOURCE THEN DELETE;";

    public static string SafeUserSegment(string userId)
    {
        if (string.IsNullOrWhiteSpace(userId))
        {
            return "_";
        }
        char[] chars = userId.ToCharArray();
        bool changed = false;
        for (int i = 0; i < chars.Length; i++)
        {
            char c = chars[i];
            bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c is '-' or '_' or '.';
            if (!ok)
            {
                chars[i] = '_';
                changed = true;
            }
        }
        string safe = new(chars);
        return changed ? $"{safe}-{ShortHash(userId)}" : safe;
    }

    private static string ShortHash(string value)
        => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..8].ToLowerInvariant();

    public static string IndexDirFor(string userId)
        => Path.Combine(DatasetManager.DatasetsFolder, SubFolder, SafeUserSegment(userId));

    public static string LancePathFor(string userId)
        => Path.Combine(IndexDirFor(userId), IndexFileName);

    public static bool Exists(string userId)
    {
        try
        {
            return Directory.Exists(LancePathFor(userId));
        }
        catch
        {
            return false;
        }
    }
}
