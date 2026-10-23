using System.IO;

namespace Quarry;

public sealed record ImageHistoryFile(string RelativePath, string AbsolutePath, long MtimeTicks, string Hash);

public static class ImageHistoryEnumerator
{
    public static readonly IReadOnlyList<string> MetadataSidecarExtensions =
        [".swarm.json", ".metadata.js"];

    public static readonly IReadOnlySet<string> Extensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "png", "jpg", "jpeg", "gif", "webp", "webm", "mp4", "mov", "mp3", "aac", "wav", "flac",
    };

    public static string HashOf(FileInfo info)
    {
        string hash = $"{info.Length}:{info.LastWriteTimeUtc.Ticks}";
        foreach (string extension in MetadataSidecarExtensions)
        {
            string sidecarPath = Path.ChangeExtension(info.FullName, extension);
            try
            {
                FileInfo sidecar = new(sidecarPath);
                if (sidecar.Exists)
                {
                    hash += $"|{extension}:{sidecar.Length}:{sidecar.LastWriteTimeUtc.Ticks}";
                }
            }
            catch
            {
            }
        }
        return hash;
    }

    public static string NormalizeDirectory(string directory)
    {
        string normalized = (directory ?? "").Trim().Replace('\\', '/');
        string[] segments = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (normalized.StartsWith('/') || normalized.Contains(':') || normalized.Contains('\0') || segments.Contains(".."))
        {
            throw new ArgumentException("Image search directory must be a subfolder relative to your image output directory, without '..'.");
        }
        return string.Join('/', segments.Where(segment => segment != "."));
    }

    public static string[] NormalizeDirectories(IEnumerable<string> directories)
    {
        string[] normalized = directories is null ? [""] : [.. directories.Select(NormalizeDirectory).Distinct(StringComparer.Ordinal)];
        if (normalized.Contains(""))
        {
            return [""];
        }
        // A selected parent already includes its descendants.
        return [.. normalized.Where(path => !normalized.Any(parent => path.StartsWith(parent + "/", StringComparison.Ordinal)))];
    }

    public static List<string> ListDirectories(string root)
    {
        List<string> result = [];
        if (!Directory.Exists(root))
        {
            return result;
        }
        EnumerationOptions options = new()
        {
            RecurseSubdirectories = false,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.Hidden | FileAttributes.System | FileAttributes.ReparsePoint,
        };
        void Visit(string parent, int depth)
        {
            foreach (string path in Directory.EnumerateDirectories(parent, "*", options).Order(StringComparer.Ordinal))
            {
                if (Path.GetFileName(path).StartsWith('.'))
                {
                    continue;
                }
                result.Add(Path.GetRelativePath(root, path).Replace('\\', '/'));
                if (depth < 2)
                {
                    Visit(path, depth + 1);
                }
            }
        }
        Visit(root, 1);
        return result;
    }

    public static List<ImageHistoryFile> Enumerate(string root, bool starNoFolders, CancellationToken cancel, IEnumerable<string> directories = null)
    {
        Dictionary<string, ImageHistoryFile> byRelative = new(StringComparer.Ordinal);
        string[] selected = NormalizeDirectories(directories);
        if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
        {
            if (selected.Any(path => path.Length > 0))
            {
                throw new DirectoryNotFoundException("Your image output directory does not exist.");
            }
            return [];
        }
        string[] scanRoots = [.. selected.Select(path => Path.Combine(root, path))];
        if (scanRoots.Any(path => !Directory.Exists(path)))
        {
            throw new DirectoryNotFoundException("A selected image search folder no longer exists. Update Image search folders in Quarry settings.");
        }
        int counter = 0;
        foreach (string abs in scanRoots.SelectMany(scanRoot => Directory.EnumerateFiles(scanRoot, "*", SearchOption.AllDirectories)))
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
