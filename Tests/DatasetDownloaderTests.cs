using Newtonsoft.Json.Linq;
using Xunit;

namespace Quarry.Tests;

public class DatasetDownloaderTests
{
    [Fact]
    public void ParseAvailableDatasets_GroupsTopLevelLanceFolders_SumsSizeAndCount_Sorted()
    {
        JArray tree = JArray.Parse(
            """
            [
              { "type": "directory", "path": "Foo.lance" },
              { "type": "file", "path": "Foo.lance/data/a.lance", "size": 100 },
              { "type": "file", "path": "Foo.lance/_versions/x.manifest", "size": 50 },
              { "type": "directory", "path": "Bar.Baz.lance" },
              { "type": "file", "path": "Bar.Baz.lance/data/b.lance", "size": 200 },
              { "type": "file", "path": "README.md", "size": 10 },
              { "type": "file", "path": ".gitattributes", "size": 5 },
              { "type": "directory", "path": "notes" },
              { "type": "file", "path": "notes/info.txt", "size": 7 }
            ]
            """);

        List<RemoteDataset> result = DatasetDownloader.ParseAvailableDatasets(tree, path => path == "Foo.lance");

        // Two datasets (README/.gitattributes/notes ignored), sorted case-insensitively by name.
        Assert.Equal(2, result.Count);

        Assert.Equal("Bar.Baz", result[0].Name);
        Assert.Equal("Bar.Baz.lance", result[0].RepoPath);
        Assert.Equal(200, result[0].SizeBytes);
        Assert.Equal(1, result[0].FileCount);
        Assert.False(result[0].Installed);

        Assert.Equal("Foo", result[1].Name);
        Assert.Equal("Foo.lance", result[1].RepoPath);
        Assert.Equal(150, result[1].SizeBytes); // 100 + 50, directory entries don't count
        Assert.Equal(2, result[1].FileCount);
        Assert.True(result[1].Installed); // the injected predicate matched "Foo.lance"
    }

    [Fact]
    public void ParseAvailableDatasets_IgnoresTopLevelFilesAndNonLanceDirs()
    {
        JArray tree = JArray.Parse(
            """
            [
              { "type": "file", "path": "README.md", "size": 10 },
              { "type": "file", "path": ".gitattributes", "size": 5 },
              { "type": "file", "path": "notes/info.txt", "size": 7 }
            ]
            """);

        Assert.Empty(DatasetDownloader.ParseAvailableDatasets(tree, _ => false));
    }

    [Fact]
    public void ParseDatasetFiles_ReturnsOnlyFilesUnderPrefix_WithRelativePaths()
    {
        JArray tree = JArray.Parse(
            """
            [
              { "type": "directory", "path": "Foo.lance/data" },
              { "type": "file", "path": "Foo.lance/data/a.lance", "size": 100 },
              { "type": "file", "path": "Foo.lance/_versions/x.manifest", "size": 50 },
              { "type": "file", "path": "Other.lance/data/c.lance", "size": 1 }
            ]
            """);

        List<RemoteFile> files = DatasetDownloader.ParseDatasetFiles(tree, "Foo.lance");

        Assert.Equal(2, files.Count);
        RemoteFile data = files.First(f => f.RelativePath == "data/a.lance");
        Assert.Equal("Foo.lance/data/a.lance", data.RepoPath);
        Assert.Equal(100, data.SizeBytes);
        Assert.Contains(files, f => f.RelativePath == "_versions/x.manifest" && f.SizeBytes == 50);
        // A different dataset's files are excluded even though they were in the same tree payload.
        Assert.DoesNotContain(files, f => f.RepoPath.StartsWith("Other.lance"));
    }
}
