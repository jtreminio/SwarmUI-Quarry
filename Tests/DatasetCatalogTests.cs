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
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        File.WriteAllText(path, text);
        return path;
    }

    [Fact]
    public void Catalog_ResolvesEveryExplicitAliasAndRootName_CaseInsensitively()
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
                Assert.Equal(entry.Name, DatasetCatalog.CanonicalName(alias[(alias.LastIndexOf('/') + 1)..]));
            }
        }
        Assert.Equal("custom/Chat-Error-tinystories-gpt4-train", DatasetCatalog.CanonicalName("custom/Chat-Error-tinystories-gpt4-train"));
        Assert.Null(DatasetCatalog.CanonicalName(null));
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
    [InlineData(".jsonl")]
    [InlineData(".csv")]
    public void Migration_CollisionKeepsBothCopiesIncludingDifferentFormats(string extension)
    {
        string oldPath = WriteDataset(Old, text: "old data");
        string newPath = WriteDataset(New, extension, "new data");
        Assert.Equal(0, DatasetMigrator.RenameKnownDatasets(_root));
        Assert.Equal("old data", File.ReadAllText(oldPath));
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

    [Fact]
    public void SyncAndQuery_OldQualifiedAndRootTagsResolveCanonicalDataset_WithoutDuplicates()
    {
        WriteDataset(Old);
        DatasetManager.Sync();
        Assert.Equal(New, DatasetManager.Resolve(Old).Name);
        Assert.Equal(New, DatasetManager.Resolve("CHAT-ERROR-TINYSTORIES-GPT4-TRAIN").Name);
        Assert.Equal(New, DatasetManager.Resolve(New).Name);
        QueryRunResult result = QueryRunner.Run($"<q:{Old},Chat-Error-tinystories-gpt4-train,{New}>", 25);
        Assert.Null(result.Invalid);
        Assert.Equal("a story", Assert.Single(result.Rows).Prompt);
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
