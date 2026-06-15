namespace Quarry;

public static class WildcardNaming
{
    /// <summary>Normalizes a relative path to a dataset name: forward slashes, no leading slash, and the
    /// final segment's extension stripped. e.g. <c>prompts\1girl.parquet</c> → <c>prompts/1girl</c>.</summary>
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
}
