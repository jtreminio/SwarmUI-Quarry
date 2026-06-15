namespace Quarry;

public static class WildcardNaming
{
    public static string ToWildcardName(string relativePath)
    {
        string normalized = relativePath.Replace('\\', '/').TrimStart('/');
        int lastSlash = normalized.LastIndexOf('/');
        int lastDot = normalized.LastIndexOf('.');
        if (lastDot > lastSlash)
        {
            normalized = normalized[..lastDot];
        }
        return normalized;
    }
}
