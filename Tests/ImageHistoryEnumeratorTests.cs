using Xunit;

namespace Quarry.Tests;

public class ImageHistoryEnumeratorTests
{
    [Theory]
    [InlineData(null, "")]
    [InlineData("  ", "")]
    [InlineData("./", "")]
    [InlineData(" raw//2026/./ ", "raw/2026")]
    [InlineData("raw\\2026\\", "raw/2026")]
    public void NormalizeDirectory_AcceptsRelativeFolders(string input, string expected)
        => Assert.Equal(expected, ImageHistoryEnumerator.NormalizeDirectory(input));

    [Theory]
    [InlineData("../outside")]
    [InlineData("raw/../../outside")]
    [InlineData("/tmp/images")]
    [InlineData("C:\\images")]
    [InlineData("\\\\server\\images")]
    public void NormalizeDirectory_RejectsTraversalAndAbsolutePaths(string input)
        => Assert.Throws<ArgumentException>(() => ImageHistoryEnumerator.NormalizeDirectory(input));

    [Fact]
    public void NormalizeDirectories_AllOverridesOthersAndParentsCoverDescendants()
    {
        Assert.Equal(new[] { "" }, ImageHistoryEnumerator.NormalizeDirectories(["raw", "", "Starred"]));
        Assert.Equal(new[] { "raw", "Starred" }, ImageHistoryEnumerator.NormalizeDirectories(["raw/nested", "raw", "raw/", "Starred"]));
        Assert.Empty(ImageHistoryEnumerator.NormalizeDirectories([]));
        Assert.Equal(new[] { "" }, ImageHistoryEnumerator.NormalizeDirectories(null));
    }

    [Fact]
    public void ListDirectories_StopsAtTwoLevelsAndScanContinuesDeeper()
    {
        string root = Path.Combine(Path.GetTempPath(), "quarry-folder-list-" + Guid.NewGuid().ToString("N"));
        try
        {
            foreach (string folder in new[] { "raw/2026/deep", "Starred", "Grids/batch", ".hidden/child" })
            {
                Directory.CreateDirectory(Path.Combine(root, folder));
                System.IO.File.WriteAllText(Path.Combine(root, folder, "image.png"), "image");
            }
            Assert.Equal(new[] { "Grids", "Grids/batch", "Starred", "raw", "raw/2026" }, ImageHistoryEnumerator.ListDirectories(root));
            var files = ImageHistoryEnumerator.Enumerate(root, false, CancellationToken.None, ["raw", "raw/2026", "Grids"]);
            Assert.Equal(new[] { "Grids/batch/image.png", "raw/2026/deep/image.png" }, files.Select(f => f.RelativePath).Order());
            Assert.Empty(ImageHistoryEnumerator.Enumerate(root, false, CancellationToken.None, []));
            Assert.Empty(ImageHistoryEnumerator.ListDirectories(Path.Combine(root, "missing")));
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Fact]
    public void Enumerate_LimitsRecursivelyAndPreservesOutputRelativePaths()
    {
        string root = Path.Combine(Path.GetTempPath(), "quarry-search-directory-" + Guid.NewGuid().ToString("N"));
        string[] paths = ["raw/a.png", "raw/nested/b.webp", "raw-other/c.png", "other/d.png", "Starred/raw/a.png"];
        try
        {
            foreach (string path in paths)
            {
                string absolute = Path.Combine(root, path);
                Directory.CreateDirectory(Path.GetDirectoryName(absolute)!);
                System.IO.File.WriteAllText(absolute, "image");
            }
            List<ImageHistoryFile> files = ImageHistoryEnumerator.Enumerate(root, false, CancellationToken.None, ["raw/"]);
            Assert.Equal(new[] { "raw/a.png", "raw/nested/b.webp" }, files.Select(f => f.RelativePath).Order());
            Assert.All(files, file => Assert.Equal(Path.Combine(root, file.RelativePath), file.AbsolutePath));
            Assert.Equal(4, ImageHistoryEnumerator.Enumerate(root, false, CancellationToken.None).Count);
            Assert.Throws<DirectoryNotFoundException>(() => ImageHistoryEnumerator.Enumerate(root, false, CancellationToken.None, ["missing"]));
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    private static ImageHistoryFile File(string relative) => new(relative, $"/abs/{relative}", 1L, "1:1");

    [Fact]
    public void DeduplicateStarred_DropsRootCopyWhenStarredCopyExists()
    {
        List<ImageHistoryFile> files =
        [
            File("raw/a.png"),
            File("Starred/raw/a.png"),
            File("raw/b.png"),
        ];
        List<string> paths = [.. ImageHistoryEnumerator.DeduplicateStarred(files, starNoFolders: false).Select(f => f.RelativePath)];
        Assert.DoesNotContain("raw/a.png", paths); // superseded by its Starred/ copy
        Assert.Contains("Starred/raw/a.png", paths);
        Assert.Contains("raw/b.png", paths);
    }

    [Fact]
    public void DeduplicateStarred_StarNoFolders_MatchesFlattenedStarredName()
    {
        // With StarNoFolders, the starred copy of "raw/a.png" lives at "Starred/rawa.png" (slashes stripped).
        List<ImageHistoryFile> files =
        [
            File("raw/a.png"),
            File("Starred/rawa.png"),
            File("raw/b.png"),
        ];
        List<string> paths = [.. ImageHistoryEnumerator.DeduplicateStarred(files, starNoFolders: true).Select(f => f.RelativePath)];
        Assert.DoesNotContain("raw/a.png", paths);
        Assert.Contains("Starred/rawa.png", paths);
        Assert.Contains("raw/b.png", paths);
    }

    [Fact]
    public void DeduplicateStarred_KeepsRootWhenNoStarredCopy()
    {
        List<ImageHistoryFile> files = [File("raw/a.png"), File("raw/b.png")];
        Assert.Equal(2, ImageHistoryEnumerator.DeduplicateStarred(files, starNoFolders: false).Count);
    }

    [Fact]
    public void HashOf_ChangesWhenGridMetadataSidecarChanges()
    {
        string dir = Path.Combine(Path.GetTempPath(), "quarry-grid-hash-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            string mediaPath = Path.Combine(dir, "video.mp4");
            string metadataPath = Path.Combine(dir, "video.metadata.js");
            System.IO.File.WriteAllText(mediaPath, "video");
            FileInfo media = new(mediaPath);
            string withoutSidecar = ImageHistoryEnumerator.HashOf(media);

            System.IO.File.WriteAllText(metadataPath, "one");
            string first = ImageHistoryEnumerator.HashOf(media);
            System.IO.File.WriteAllText(metadataPath, "longer metadata");
            string second = ImageHistoryEnumerator.HashOf(media);

            Assert.NotEqual(withoutSidecar, first);
            Assert.NotEqual(first, second);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
