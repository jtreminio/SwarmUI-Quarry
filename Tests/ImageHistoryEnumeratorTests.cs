using Xunit;

namespace Quarry.Tests;

public class ImageHistoryEnumeratorTests
{
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
}
