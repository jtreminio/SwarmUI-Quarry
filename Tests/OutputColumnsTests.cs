using System.IO;
using SwarmUI.Text2Image;
using Xunit;

namespace Quarry.Tests;

// DatasetManager owns process-wide state. These integration tests must run without other cache tests.
[CollectionDefinition("OutputColumns", DisableParallelization = true)]
public class OutputColumnsCollection
{
}

[Collection("OutputColumns")]
public class OutputColumnsTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "quarry-output-" + Guid.NewGuid().ToString("N"));
    private readonly string _previousDatasets = DatasetManager.DatasetsFolder;
    private readonly string _previousExtension = DatasetManager.ExtensionFolder;
    private readonly string _characters;

    public OutputColumnsTests()
    {
        string datasets = Path.Combine(_root, "datasets");
        Directory.CreateDirectory(datasets);
        _characters = Path.Combine(datasets, "characters.jsonl");
        File.WriteAllText(_characters, """
            {"prompt":"goth portrait","appearance":" silver hair ","clothing":"black jacket","pose":"standing","extras":["moonlight","fog"],"score":0}
            {"prompt":"punk portrait","appearance":"red hair","clothing":null,"pose":"   ","extras":[],"score":5}
            """);
        File.WriteAllText(Path.Combine(datasets, "creatures.jsonl"), """
            {"prompt":"goth creature","appearance":"scales","pose":"flying"}
            """);
        File.WriteAllText(Path.Combine(datasets, "other.jsonl"), """
            {"prompt":"unrelated default"}
            """);
        DatasetManager.ExtensionFolder = _root;
        DatasetManager.DatasetsFolder = datasets;
        DatasetManager.Sync();
    }

    [Fact]
    public void OffsetReads_KeepColumnsOnSameRow_AndSkipBlankValues()
    {
        Assert.Equal("standing, silver hair, black jacket", DatasetManager.Backend.GetPromptAt(
            _characters, ["pose", "appearance", "clothing"], SqlFilter.None, 0));
        Assert.Equal("red hair", DatasetManager.Backend.GetPromptAt(
            _characters, ["pose", "appearance", "clothing"], SqlFilter.None, 1));
        Assert.Equal("silver hair, moonlight, fog, 0", DatasetManager.Backend.GetPromptAt(
            _characters, ["appearance", "extras", "score"], SqlFilter.None, 0));
        Assert.Equal("", DatasetManager.Backend.GetPromptAt(_characters, ["appearance"], SqlFilter.None, 99));
    }

    [Fact]
    public void CandidateReads_ReturnMatchingFlagAfterAllSelectedColumns()
    {
        SqlFilter filter = new("score = 5", []);
        Assert.Equal(("silver hair, black jacket", false), DatasetManager.Backend.GetCandidateAt(
            _characters, ["appearance", "clothing"], filter, 0));
        Assert.Equal(("red hair", true), DatasetManager.Backend.GetCandidateAt(
            _characters, ["appearance", "clothing"], filter, 1));
        Assert.Equal("red hair", DatasetManager.Backend.GetPromptAt(
            _characters, ["appearance", "clothing"], filter, 0));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Sampler_UsesJoinedOutputForOffsetAndRejectionPaths(bool filtered)
    {
        DatasetEntry entry = DatasetManager.Resolve("characters");
        MatchedDataset matched = new(entry, ["appearance", "clothing"],
            filtered ? new SqlFilter("score = 5", []) : SqlFilter.None, filtered ? 1 : 2, 2);
        T2IPromptHandling.PromptTagContext context = new() { Input = new T2IParamInput(null) };
        Assert.Equal(filtered ? "red hair" : "silver hair, black jacket", PromptSampler.Fetch(matched, 0, 123, context));
        Assert.False(context.Input.ExtraMeta.ContainsKey("parser_warnings"));
    }

    [Fact]
    public void RunQuery_JoinsSameRowAcrossSchemas_SkipsMissingColumnsAndDatasets()
    {
        QueryRunResult result = QueryRunner.Run("<q:characters,creatures,other:pose,missing,appearance,clothing>", 25);
        Assert.Null(result.Invalid);
        Assert.Equal(3, result.Total);
        Assert.Equal(new[] { "standing, silver hair, black jacket", "red hair", "flying, scales" }, result.Rows.Select(row => row.Prompt));
        Assert.DoesNotContain(result.Datasets, dataset => dataset.Name == "other");
    }

    [Fact]
    public void RunQuery_AllRequestedColumnsMissing_ReturnsEmptyWithoutError()
    {
        QueryRunResult result = QueryRunner.Run("<q:characters:missing,absent>", 25);
        Assert.Null(result.Invalid);
        Assert.Equal(0, result.Total);
        Assert.Empty(result.Rows);
    }

    [Fact]
    public void RunQuery_FilterUsesDefaultPromptWhenTagColumnsAreNotConfigured()
    {
        QueryRunResult result = QueryRunner.Run("<q:characters,creatures[tags=goth]:appearance,clothing>", 25);
        Assert.Null(result.Invalid);
        Assert.Equal(new[] { "silver hair, black jacket", "scales" }, result.Rows.Select(row => row.Prompt));
    }

    [Fact]
    public void RunQuery_SingleMissingColumnKeepsDefaultFallback()
    {
        QueryRunResult result = QueryRunner.Run("<q:characters:missing>", 25);
        Assert.Null(result.Invalid);
        Assert.Equal(new[] { "goth portrait", "punk portrait" }, result.Rows.Select(row => row.Prompt));
    }

    public void Dispose()
    {
        DatasetManager.DatasetsFolder = "";
        DatasetManager.Sync();
        DatasetManager.ExtensionFolder = _previousExtension;
        DatasetManager.DatasetsFolder = _previousDatasets;
        if (!string.IsNullOrWhiteSpace(_previousDatasets))
        {
            DatasetManager.Sync();
        }
        Directory.Delete(_root, true);
    }
}
