namespace Quarry;

public static class DatasetNaming
{
    public static string ToName(string relativePath)
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
