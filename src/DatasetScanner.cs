using System.IO;

namespace Quarry;

public static class DatasetScanner
{
    public static IEnumerable<string> Enumerate(string root)
    {
        return Directory.Exists(root) ? Walk(root) : [];
    }

    private static IEnumerable<string> Walk(string dir)
    {
        foreach (string subDir in Directory.EnumerateDirectories(dir))
        {
            if (IsHidden(subDir))
            {
                continue;
            }
            if (IsLanceDir(subDir))
            {
                yield return subDir;
            }
            else
            {
                foreach (string nested in Walk(subDir))
                {
                    yield return nested;
                }
            }
        }
        foreach (string file in Directory.EnumerateFiles(dir))
        {
            if (!IsHidden(file) && !IsLanceDir(file) && DatasetSource.IsSupported(file))
            {
                yield return file;
            }
        }
    }

    private static bool IsLanceDir(string path) => path.EndsWith(".lance", StringComparison.OrdinalIgnoreCase);
    private static bool IsHidden(string path) => Path.GetFileName(path).StartsWith('.');
}
