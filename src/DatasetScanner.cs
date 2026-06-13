using System.IO;

namespace Quarry;

/// <summary>Enumerates dataset paths under a root directory: supported flat files (CSV/TSV/JSON/JSONL/
/// Parquet) plus Lance datasets (which are directories named <c>*.lance</c>, treated as leaves — we do
/// not descend into them, so their internal fragment files are not mistaken for datasets). Returns
/// absolute paths.</summary>
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
            if (!IsLanceDir(file) && DatasetSource.IsSupported(file))
            {
                yield return file;
            }
        }
    }

    private static bool IsLanceDir(string path) => path.EndsWith(".lance", StringComparison.OrdinalIgnoreCase);
}
