using System.IO;
using Xunit;

namespace Quarry.Tests;

public class DatasetScannerTests
{
    private sealed class TempDir : IDisposable
    {
        public string Path { get; } =
            System.IO.Path.Combine(System.IO.Path.GetTempPath(), "quarry-scan-" + Guid.NewGuid().ToString("N"));

        public TempDir()
        {
            Directory.CreateDirectory(Path);
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(Path, true);
            }
            catch (IOException)
            {
            }
        }
    }

    [Fact]
    public void Enumerate_FindsSupportedFiles_SkipsUnsupportedAndLanceInternals()
    {
        using TempDir tmp = new();
        string root = tmp.Path;
        File.WriteAllText(Path.Combine(root, "a.parquet"), "");
        File.WriteAllText(Path.Combine(root, "b.csv"), "");
        File.WriteAllText(Path.Combine(root, "notes.txt"), ""); // unsupported
        Directory.CreateDirectory(Path.Combine(root, "sub"));
        File.WriteAllText(Path.Combine(root, "sub", "c.jsonl"), "");

        // A Lance dataset is a directory; its internal fragment files must NOT be enumerated.
        string lance = Path.Combine(root, "d.lance");
        Directory.CreateDirectory(Path.Combine(lance, "data"));
        File.WriteAllText(Path.Combine(lance, "data", "frag.parquet"), "");

        List<string> found = DatasetScanner.Enumerate(root)
            .Select(p => Path.GetRelativePath(root, p).Replace('\\', '/'))
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToList();

        Assert.Equal(new[] { "a.parquet", "b.csv", "d.lance", "sub/c.jsonl" }, found);
    }

    [Fact]
    public void Enumerate_MissingRoot_ReturnsEmpty()
    {
        Assert.Empty(DatasetScanner.Enumerate("/no/such/dir/quarry-xyz123"));
    }
}
