namespace Quarry;

/// <summary>Maps a dataset file's path (relative to the datasets folder) to its wildcard name and to the
/// placeholder <c>.txt</c> path that mirrors it into the Wildcards folder. Pure and side-effect free.</summary>
public static class WildcardNaming
{
    /// <summary>Normalizes a relative path to a wildcard name: forward slashes, no leading slash, and the
    /// final segment's extension stripped. e.g. <c>prompts\1girl.parquet</c> → <c>prompts/1girl</c>,
    /// <c>styles.v2/list.jsonl</c> → <c>styles.v2/list</c>.</summary>
    public static string ToWildcardName(string relativePath)
    {
        string normalized = relativePath.Replace('\\', '/').TrimStart('/');
        int lastSlash = normalized.LastIndexOf('/');
        int lastDot = normalized.LastIndexOf('.');
        // Only strip an extension that belongs to the final path segment (not a dotted directory name).
        if (lastDot > lastSlash)
        {
            normalized = normalized[..lastDot];
        }
        return normalized;
    }

    /// <summary>The placeholder file's relative path within the Wildcards folder (wildcard name + ".txt").</summary>
    public static string ToPlaceholderRelativePath(string wildcardName) => wildcardName + ".txt";
}
