using System.IO;

namespace Quarry;

public sealed record ImageHistoryFile(string RelativePath, string AbsolutePath, long MtimeTicks, string Hash);

public static class ImageHistoryEnumerator
{
    public static readonly IReadOnlySet<string> Extensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "png", "jpg", "jpeg", "gif", "webp", "webm", "mp4", "mov", "mp3", "aac", "wav", "flac",
    };

    public static string HashOf(FileInfo info) => $"{info.Length}:{info.LastWriteTimeUtc.Ticks}";

    public static List<ImageHistoryFile> Enumerate(string root, bool starNoFolders, CancellationToken cancel)
    {
        Dictionary<string, ImageHistoryFile> byRelative = new(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
        {
            return [];
        }
        int counter = 0;
        foreach (string abs in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
        {
            if ((counter++ & 1023) == 0)
            {
                cancel.ThrowIfCancellationRequested();
            }
            string fileName = Path.GetFileName(abs);
            if (fileName.StartsWith('.') || abs.EndsWith(".swarmpreview.jpg") || abs.EndsWith(".swarmpreview.webp"))
            {
                continue;
            }
            string ext = Path.GetExtension(abs).TrimStart('.').ToLowerInvariant();
            if (!Extensions.Contains(ext))
            {
                continue;
            }
            string relative = Path.GetRelativePath(root, abs).Replace('\\', '/');
            if (relative.StartsWith("./", StringComparison.Ordinal))
            {
                relative = relative[2..];
            }
            if (relative.StartsWith('.') || relative.Contains("/."))
            {
                continue;
            }
            try
            {
                FileInfo info = new(abs);
                byRelative[relative] = new ImageHistoryFile(relative, abs, info.LastWriteTimeUtc.Ticks, HashOf(info));
            }
            catch
            {
            }
        }
        return DeduplicateStarred(byRelative.Values, starNoFolders);
    }

    internal static List<ImageHistoryFile> DeduplicateStarred(IReadOnlyCollection<ImageHistoryFile> files, bool starNoFolders)
    {
        HashSet<string> present = [.. files.Select(f => f.RelativePath)];
        List<ImageHistoryFile> result = new(files.Count);
        foreach (ImageHistoryFile file in files)
        {
            if (!file.RelativePath.StartsWith("Starred/", StringComparison.OrdinalIgnoreCase))
            {
                string starName = starNoFolders ? file.RelativePath.Replace("/", "") : file.RelativePath;
                if (present.Contains($"Starred/{starName}"))
                {
                    continue;
                }
            }
            result.Add(file);
        }
        return result;
    }
}
