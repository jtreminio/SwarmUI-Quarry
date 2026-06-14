using System.IO;

namespace Quarry;

/// <summary>Enumerates dataset paths under a root directory: supported flat files (CSV/TSV/JSON/JSONL/
/// Parquet) plus Lance datasets (which are directories named <c>*.lance</c>, treated as leaves — we do
/// not descend into them, so their internal fragment files are not mistaken for datasets). Hidden entries
/// (names starting with <c>.</c>) are skipped, so tool caches such as
/// <c>.cache/huggingface/upload/*.lance</c> — which hold incomplete, unopenable datasets — are never
/// picked up. Returns absolute paths.</summary>
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

    /// <summary>True when the final path segment starts with a dot (e.g. <c>.cache</c>, <c>.git</c>).</summary>
    private static bool IsHidden(string path) => Path.GetFileName(path).StartsWith('.');
}
