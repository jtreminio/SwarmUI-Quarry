using System.IO;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Quarry.Tests;

[Collection("OutputColumns")]
public class DatasetCatalogTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "quarry-renames-" + Guid.NewGuid().ToString("N"));
    private readonly string _previousFolder = DatasetManager.DatasetsFolder;
    private readonly string _previousExtension = DatasetManager.ExtensionFolder;
    private readonly IReadOnlyDictionary<string, string> _promptColumns = ColumnConfig.GetPromptColumnsSnapshot();
    private readonly IReadOnlyDictionary<string, IReadOnlyList<string>> _tagColumns = ColumnConfig.GetTagColumnsSnapshot();
    private readonly IReadOnlyList<string> _disabled = DatasetEnabledConfig.GetDisabledSnapshot();
    private const string Old = "short-stories/Chat-Error-tinystories-gpt4-train";
    private const string New = "short-stories/Chat-Error.tinystories-gpt4.train";

    public DatasetCatalogTests()
    {
        Directory.CreateDirectory(_root);
        DatasetManager.DatasetsFolder = _root;
        DatasetManager.ExtensionFolder = _root;
    }

    private string WriteDataset(string name, string extension = ".jsonl", string text = "{\"prompt\":\"a story\",\"text\":\"the story\"}")
    {
        string path = Path.Combine(_root, name + extension);
        string dataPath = extension == ".lance" ? Path.Combine(path, "data", "original.bin") : path;
        Directory.CreateDirectory(Path.GetDirectoryName(dataPath));
        File.WriteAllText(dataPath, text);
        return path;
    }

    [Fact]
    public void Catalog_ResolvesEveryExplicitNameAndAlias_CaseInsensitively()
    {
        Assert.Equal(25, DatasetCatalog.Entries.Count(entry => entry.Alias is not null));
        foreach (DatasetAttribution entry in DatasetCatalog.Entries)
        {
            foreach (string alias in new[] { entry.Name, entry.Alias })
            {
                if (alias is null)
                {
                    continue;
                }
                Assert.Equal(entry.Name, DatasetCatalog.CanonicalName(alias));
                Assert.Equal(entry.Name, DatasetCatalog.CanonicalName(alias.ToUpperInvariant()));
            }
        }
        Assert.Equal("custom/Chat-Error-tinystories-gpt4-train", DatasetCatalog.CanonicalName("custom/Chat-Error-tinystories-gpt4-train"));
        Assert.Null(DatasetCatalog.CanonicalName(null));
    }

    [Fact]
    public void Catalog_ResolvesUnambiguousRootNamesAndAliases_CaseInsensitively()
    {
        var names = DatasetCatalog.BuildNames([
            new("nl/org.example", "nl/old-name", "https://example.com/source"),
        ]);
        foreach (string name in new[] { "nl/org.example", "nl/old-name", "org.example", "old-name" })
        {
            Assert.Equal("nl/org.example", names[name]);
            Assert.Equal("nl/org.example", names[name.ToUpperInvariant()]);
        }
    }

    [Fact]
    public void Catalog_KeepsDatasetsWithTheSameLeafNameDistinct()
    {
        var names = DatasetCatalog.BuildNames([
            new("nl/org.example", "nl/old-name", "https://example.com/nl"),
            new("tags/org.example", null, "https://example.com/tags"),
        ]);
        Assert.Equal("nl/org.example", names["NL/ORG.EXAMPLE"]);
        Assert.Equal("tags/org.example", names["TAGS/ORG.EXAMPLE"]);
        Assert.Equal("nl/org.example", names["OLD-NAME"]);
        Assert.False(names.ContainsKey("org.example"));
        Assert.False(names.ContainsKey("ORG.EXAMPLE"));
    }

    [Fact]
    public void Catalog_ExplicitRootNameTakesPrecedenceOverShortcuts()
    {
        var names = DatasetCatalog.BuildNames([
            new("nl/org.example", null, "https://example.com/nl"),
            new("org.example", null, "https://example.com/root"),
        ]);
        Assert.Equal("nl/org.example", names["nl/org.example"]);
        Assert.Equal("org.example", names["ORG.EXAMPLE"]);
    }

    [Fact]
    public void Migration_RenamesEveryKnownLanceDirectory_PreservesContentsAndIsRepeatable()
    {
        foreach (DatasetAttribution entry in DatasetCatalog.Entries.Where(entry => entry.Alias is not null))
        {
            string path = Path.Combine(_root, entry.Alias + ".lance", "data");
            Directory.CreateDirectory(path);
            File.WriteAllText(Path.Combine(path, "original.bin"), entry.Name);
        }
        File.WriteAllText(Path.Combine(_root, ".quarry-nl-tags-migrated"), "done");
        Assert.Equal(25, DatasetMigrator.RenameKnownDatasets(_root));
        foreach (DatasetAttribution entry in DatasetCatalog.Entries.Where(entry => entry.Alias is not null))
        {
            Assert.False(Directory.Exists(Path.Combine(_root, entry.Alias + ".lance")));
            Assert.Equal(entry.Name, File.ReadAllText(Path.Combine(_root, entry.Name + ".lance", "data", "original.bin")));
        }
        Assert.Equal(0, DatasetMigrator.RenameKnownDatasets(_root));
    }

    [Fact]
    public void Migration_MissingDatasetsAreSkipped_AndLaterInstallIsMigrated()
    {
        Assert.Equal(0, DatasetMigrator.RenameKnownDatasets(_root));
        string oldPath = WriteDataset("Chat-Error-tinystories-gpt4-train", ".csv", "prompt\na story");
        Assert.Equal(1, DatasetMigrator.RenameKnownDatasets(_root));
        Assert.False(File.Exists(oldPath));
        Assert.Equal("prompt\na story", File.ReadAllText(Path.Combine(_root, New + ".csv")));
    }

    [Theory]
    [InlineData(".jsonl", ".jsonl")]
    [InlineData(".jsonl", ".csv")]
    [InlineData(".lance", ".lance")]
    [InlineData(".lance", ".jsonl")]
    [InlineData(".jsonl", ".lance")]
    public void Migration_CollisionRemovesLegacyCopy_PreservesCanonicalContentsAndCache(string oldExtension, string newExtension)
    {
        string oldPath = WriteDataset(Old, oldExtension, "old data");
        string newPath = WriteDataset(New, newExtension, "new data");
        DatasetCache.StoreRowCount(Old.ToLowerInvariant(), "old hash", "prompt", 42);
        DatasetCache.StoreRowCount(New.ToLowerInvariant(), "new hash", "prompt", 99);
        int resets = 0;
        Assert.Equal(1, DatasetMigrator.RenameKnownDatasets(_root, () =>
        {
            Assert.True(File.Exists(oldPath) || Directory.Exists(oldPath));
            resets++;
        }));
        Assert.Equal(1, resets);
        Assert.False(File.Exists(oldPath));
        Assert.False(Directory.Exists(oldPath));
        string dataPath = newExtension == ".lance" ? Path.Combine(newPath, "data", "original.bin") : newPath;
        Assert.Equal("new data", File.ReadAllText(dataPath));
        Assert.False(DatasetCache.TryGetRowCount(Old.ToLowerInvariant(), "old hash", "prompt", out _));
        Assert.True(DatasetCache.TryGetRowCount(New.ToLowerInvariant(), "new hash", "prompt", out long count));
        Assert.Equal(99, count);
        Assert.Equal(0, DatasetMigrator.RenameKnownDatasets(_root));
    }

    [Theory]
    [InlineData(".jsonl")]
    [InlineData(".lance")]
    public void Migration_NonDatasetDestinationDoesNotCauseDeletion(string extension)
    {
        string oldPath = WriteDataset(Old, extension, "old data");
        string destination = Path.Combine(_root, New + extension);
        if (extension == ".lance")
        {
            File.WriteAllText(destination, "obstruction");
        }
        else
        {
            Directory.CreateDirectory(destination);
        }
        Assert.Equal(0, DatasetMigrator.RenameKnownDatasets(_root));
        string dataPath = extension == ".lance" ? Path.Combine(oldPath, "data", "original.bin") : oldPath;
        Assert.Equal("old data", File.ReadAllText(dataPath));
    }

    [Fact]
    public void Migration_FailedResetPreservesBothCopies_AndRetriesLater()
    {
        string oldPath = WriteDataset(Old, text: "old data");
        string newPath = WriteDataset(New, text: "new data");
        Assert.Equal(0, DatasetMigrator.RenameKnownDatasets(_root, () => throw new IOException("Cannot release dataset")));
        Assert.Equal("old data", File.ReadAllText(oldPath));
        Assert.Equal("new data", File.ReadAllText(newPath));
        Assert.Equal(1, DatasetMigrator.RenameKnownDatasets(_root));
        Assert.False(File.Exists(oldPath));
        Assert.Equal("new data", File.ReadAllText(newPath));
    }

    [Fact]
    public void Migration_PreservesCachedRowCount()
    {
        WriteDataset(Old);
        DatasetCache.StoreRowCount(Old.ToLowerInvariant(), "hash", "prompt", 42);
        Assert.Equal(1, DatasetMigrator.RenameKnownDatasets(_root));
        Assert.True(DatasetCache.TryGetRowCount(New.ToLowerInvariant(), "hash", "prompt", out long count));
        Assert.Equal(42, count);
        Assert.False(DatasetCache.TryGetRowCount(Old.ToLowerInvariant(), "hash", "prompt", out _));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SyncAndQuery_OldQualifiedAndRootTagsResolveCanonicalDataset_WithoutDuplicates(bool canonicalAlreadyDownloaded)
    {
        WriteDataset(Old);
        if (canonicalAlreadyDownloaded)
        {
            WriteDataset(New, text: "{\"prompt\":\"downloaded story\"}");
        }
        DatasetManager.Sync();
        Assert.Equal(New, Assert.Single(DatasetManager.AllDatasets).Name);
        Assert.Equal(New, DatasetManager.Resolve(Old).Name);
        Assert.Equal(New, DatasetManager.Resolve("CHAT-ERROR-TINYSTORIES-GPT4-TRAIN").Name);
        Assert.Equal(New, DatasetManager.Resolve(New).Name);
        QueryRunResult result = QueryRunner.Run($"<q:{Old},Chat-Error-tinystories-gpt4-train,{New}>", 25);
        Assert.Null(result.Invalid);
        Assert.Equal(canonicalAlreadyDownloaded ? "downloaded story" : "a story", Assert.Single(result.Rows).Prompt);
        Assert.Equal(new[] { New }, PromptTagHandler.ResolveReferencedDatasetNames($"<q:{Old}>"));
    }

    [Fact]
    public void LeafReferences_ResolveDatasetsInCustomCategories()
    {
        WriteDataset("custom/Gustavosta.Stable-Diffusion-Prompts");
        WriteDataset("custom/Chat-Error-tinystories-gpt4-train");
        DatasetManager.Sync();
        foreach (string leaf in new[] { "Gustavosta.Stable-Diffusion-Prompts", "Chat-Error-tinystories-gpt4-train" })
        {
            Assert.Equal("custom/" + leaf, DatasetManager.Resolve(leaf).Name);
            QueryRunResult result = QueryRunner.Run($"<q:{leaf}>", 25);
            Assert.Null(result.Invalid);
            Assert.Equal("a story", Assert.Single(result.Rows).Prompt);
        }
    }

    [Fact]
    public void MissingAlias_DoesNotSelectASubsetInstead()
    {
        WriteDataset("short-stories/agentlans.lemonilia-LimaRP.scenario");
        DatasetManager.Sync();
        QueryRunResult result = QueryRunner.Run("<q:short-stories/agentlans-lemonilia-LimaRP>", 25);
        Assert.NotNull(result.Invalid);
        Assert.Empty(result.Rows);
    }

    [Fact]
    public void Settings_OldNamesPreserveColumnsAndDisabledState_CanonicalSettingsWin()
    {
        ColumnConfig.SetPromptColumns(new Dictionary<string, string> { [New] = "prompt", [Old] = "text" });
        Assert.Equal("prompt", ColumnConfig.GetPromptColumn(Old));
        ColumnConfig.SetPromptColumns(new Dictionary<string, string> { [New.ToUpperInvariant()] = "prompt", [Old] = "text" });
        ColumnConfig.SetTagColumns(new Dictionary<string, IReadOnlyList<string>>
        {
            [New.ToUpperInvariant()] = new[] { "prompt" },
            [Old] = new[] { "text" }
        });
        Assert.Equal("prompt", ColumnConfig.GetPromptColumn(Old));
        Assert.Equal(new[] { "prompt" }, ColumnConfig.GetTagColumns(Old));
        ColumnConfig.SetPromptColumns(new Dictionary<string, string> { [Old] = "text" });
        ColumnConfig.SetTagColumns(new Dictionary<string, IReadOnlyList<string>> { [Old] = new[] { "text" } });
        DatasetEnabledConfig.SetDisabled(new[] { Old });
        Assert.Equal("text", ColumnConfig.GetPromptColumn(New));
        Assert.Equal(new[] { "text" }, ColumnConfig.GetTagColumns(New));
        Assert.False(DatasetEnabledConfig.IsEnabled(New));
        Assert.Equal(new[] { New }, DatasetEnabledConfig.GetDisabledSnapshot());
        Assert.True(ColumnConfig.GetPromptColumnsSnapshot().ContainsKey(New));
        DatasetEnabledConfig.SetEnabled(Old, true);
        Assert.True(DatasetEnabledConfig.IsEnabled(New));
    }

    [Fact]
    public void DownloadListing_UsesCanonicalNameAndInstalledPath_KeepsRemotePathForFetching()
    {
        JArray tree = new(new JObject { ["type"] = "file", ["path"] = Old + ".lance/data/one.lance", ["size"] = 100 });
        RemoteDataset dataset = Assert.Single(DatasetDownloader.ParseAvailableDatasets(tree, path => path == New + ".lance"));
        Assert.Equal(New, dataset.Name);
        Assert.Equal(Old + ".lance", dataset.RepoPath);
        Assert.Equal(New + ".lance", DatasetCatalog.LocalPath(dataset.RepoPath));
        Assert.True(dataset.Installed);
        tree.Add(new JObject { ["type"] = "file", ["path"] = New + ".lance/data/one.lance", ["size"] = 200 });
        dataset = Assert.Single(DatasetDownloader.ParseAvailableDatasets(tree, path => path == Old + ".lance"));
        Assert.Equal(New + ".lance", dataset.RepoPath);
        Assert.Equal(200, dataset.SizeBytes);
        Assert.True(dataset.Installed);
    }

    public void Dispose()
    {
        DatasetCache.Remove(Old.ToLowerInvariant());
        DatasetCache.Remove(New.ToLowerInvariant());
        DatasetManager.DatasetsFolder = "";
        DatasetManager.Sync();
        DatasetManager.Backend.Reset();
        ColumnConfig.SetPromptColumns(_promptColumns);
        ColumnConfig.SetTagColumns(_tagColumns);
        DatasetEnabledConfig.SetDisabled(_disabled);
        DatasetManager.ExtensionFolder = _previousExtension;
        DatasetManager.DatasetsFolder = _previousFolder;
        if (!string.IsNullOrWhiteSpace(_previousFolder))
        {
            DatasetManager.Sync();
        }
        Directory.Delete(_root, true);
    }
}
