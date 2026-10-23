using System.IO;
using System.Text.Json;
using DuckDB.NET.Data;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Quarry.Tests;

[Collection("OutputColumns")]
public sealed class RandomExploreTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "quarry-random-explore-" + Guid.NewGuid().ToString("N"));
    private readonly string oldFolder = DatasetManager.DatasetsFolder;
    private readonly string oldExtension = DatasetManager.ExtensionFolder;
    private readonly string path;

    public RandomExploreTests()
    {
        Directory.CreateDirectory(root);
        path = Path.Combine(root, "sample.jsonl");
        File.WriteAllLines(path, Enumerable.Range(0, 200).Select(i => JsonSerializer.Serialize(new
        {
            prompt = $"Row {i:D3}", score = i, subject = new { hair = $"Hair {i:D3}", expression = "Happy" }
        })));
        DatasetManager.ExtensionFolder = root;
        DatasetManager.DatasetsFolder = root;
        DatasetManager.Sync();
    }

    [Fact]
    public async Task PreviewDrawsFreshRandomRowsAndBypassesTheOldCache()
    {
        // Seed the old deterministic preview cache; interactive draws must ignore it.
        Assert.Equal("Row 000", DatasetManager.PreviewDataset("sample", 10).Rows[0][0]);
        QuarryExtension extension = new();
        HashSet<string> draws = [];
        HashSet<string> seen = [];
        for (int i = 0; i < 5; i++)
        {
            JObject result = await extension.QuarryPreviewDataset(null, "sample", 10);
            Assert.True(result.Value<bool>("success"));
            Assert.Equal(200, result.Value<long>("rowCount"));
            string[] values = result["rows"].Select(row => row[0].Value<string>()).ToArray();
            Assert.Equal(10, values.Length);
            Assert.Equal(10, values.Distinct().Count());
            draws.Add(string.Join("|", values));
            seen.UnionWith(values);
        }
        Assert.True(draws.Count > 1);
        Assert.Contains(seen, value => int.Parse(value[4..]) >= 10);
        Assert.Equal("Row 000", DatasetManager.Backend.GetPromptAt(path, ["prompt"], SqlFilter.None, 0));
    }

    [Fact]
    public async Task PreviewCapsOversizedRequestsAt100Rows()
    {
        JObject result = await new QuarryExtension().QuarryPreviewDataset(null, "sample", 10000);
        Assert.True(result.Value<bool>("success"));
        Assert.Equal(100, result["rows"].Count());
        Assert.Equal(200, result.Value<long>("rowCount"));
    }

    [Fact]
    public void QuerySamplesRandomMatchesWithNestedOutputsAndFormatting()
    {
        HashSet<string> draws = [];
        for (int i = 0; i < 5; i++)
        {
            QueryRunResult result = QueryRunner.Run("<q:sample[score+=100;score-=150]:prompt,subject.hair,subject.expression|keys;rs=\" / \";fs=\"; \">", 10);
            Assert.Null(result.Invalid);
            Assert.Equal(51, result.Total);
            Assert.Equal(10, result.Rows.Count);
            Assert.Equal(10, result.Rows.Select(row => row.Prompt).Distinct().Count());
            foreach (QueryRunRow row in result.Rows)
            {
                string[] parts = row.Prompt.Split(" / ");
                int number = int.Parse(parts[0]["prompt: Row ".Length..]);
                Assert.InRange(number, 100, 150);
                Assert.Equal($"hair: Hair {number:D3}", parts[1]);
                Assert.Equal("expression: Happy", parts[2]);
            }
            draws.Add(string.Join("|", result.Rows.Select(row => row.Prompt)));
        }
        Assert.True(draws.Count > 1);
    }

    [Fact]
    public void LanceSamplesRandomMatchingRowsAndRestoresCasing()
    {
        using (DuckDBConnection connection = new("DataSource=:memory:"))
        {
            connection.Open();
            using DuckDBCommand command = connection.CreateCommand();
            command.CommandText = $"INSTALL lance; LOAD lance; ATTACH {SqlText.QuoteLiteral(root)} AS test (TYPE lance); CREATE TABLE test.main.stored AS SELECT 'row ' || lpad(CAST(i AS VARCHAR), 3, '0') AS prompt, from_hex('5300') AS prompt__case, i AS score FROM range(200) t(i); DETACH test;";
            command.ExecuteNonQuery();
        }
        string lancePath = Path.Combine(root, "stored.lance");
        File.WriteAllText(Path.Combine(lancePath, CasingStorage.DescriptorName), """{"version":1,"columns":{"prompt":"prompt__case"}}""");
        DatasetManager.Sync();
        HashSet<string> draws = [];
        for (int i = 0; i < 4; i++)
        {
            QueryRunResult result = QueryRunner.Run("<q:stored[score+=100;score-=150]:prompt|keys>", 10);
            Assert.Null(result.Invalid);
            Assert.Equal(51, result.Total);
            Assert.Equal(10, result.Rows.Count);
            Assert.Equal(10, result.Rows.Select(row => row.Prompt).Distinct().Count());
            Assert.All(result.Rows, row =>
            {
                Assert.StartsWith("prompt: Row ", row.Prompt);
                Assert.InRange(int.Parse(row.Prompt["prompt: Row ".Length..]), 100, 150);
            });
            draws.Add(string.Join("|", result.Rows.Select(row => row.Prompt)));
        }
        Assert.True(draws.Count > 1);
        var preview = DatasetManager.Backend.GetRandomSampleRows(lancePath, 10);
        Assert.Equal(new[] { "prompt", "score" }, preview.Columns);
        Assert.All(preview.Rows, row => Assert.StartsWith("Row ", row[0]));
    }

    [Fact]
    public void LancePhysicalSamplingPreservesNestedOutputFilteringAndRowIdentity()
    {
        using (DuckDBConnection connection = new("DataSource=:memory:"))
        {
            connection.Open();
            using DuckDBCommand command = connection.CreateCommand();
            command.CommandText = $"INSTALL lance; LOAD lance; ATTACH {SqlText.QuoteLiteral(root)} AS test (TYPE lance); "
                + "CREATE TABLE test.main.nested AS SELECT CASE WHEN i % 5 = 0 THEN [] ELSE [struct_pack(subject := 'Person ' || i, expression := 'Happy')] END AS prompt, i AS score FROM range(50, 300) t(i); DETACH test;";
            command.ExecuteNonQuery();
        }
        DatasetManager.Sync();
        HashSet<string> draws = [];
        for (int repeat = 0; repeat < 3; repeat++)
        {
            QueryRunResult result = QueryRunner.Run("<q:nested:prompt.subject|keys>", 100);
            Assert.Null(result.Invalid);
            Assert.Equal(200, result.Total);
            Assert.Equal(100, result.Rows.Count);
            Assert.Equal(100, result.Rows.Select(row => row.Prompt).Distinct().Count());
            Assert.All(result.Rows, row =>
            {
                int number = int.Parse(row.Prompt["subject: Person ".Length..]);
                Assert.InRange(number, 50, 299);
                Assert.NotEqual(0, number % 5);
            });
            draws.Add(string.Join("|", result.Rows.Select(row => row.Prompt)));
        }
        Assert.True(draws.Count > 1);
        QueryRunResult all = QueryRunner.Run("<q:nested:prompt.subject|keys>", 500);
        Assert.Equal(200, all.Rows.Count);
        Assert.Equal(200, all.Rows.Select(row => row.Prompt).Distinct().Count());
        QueryRunResult sparse = QueryRunner.Run("<q:nested[score+=299]:prompt.subject|keys>", 100);
        Assert.Equal(1, sparse.Total);
        Assert.Equal("subject: Person 299", Assert.Single(sparse.Rows).Prompt);
        QueryRunResult empty = QueryRunner.Run("<q:nested[score+=300]:prompt.subject|keys>", 100);
        Assert.Equal(0, empty.Total);
        Assert.Empty(empty.Rows);
        var preview = DatasetManager.Backend.GetRandomSampleRows(Path.Combine(root, "nested.lance"), 500);
        Assert.Equal(250, preview.Rows.Count);
        Assert.Equal(250, preview.Rows.Select(row => row[1]).Distinct().Count());
        Assert.All(preview.Rows, row => Assert.InRange(int.Parse(row[1]), 50, 299));
    }

    public void Dispose()
    {
        DatasetManager.DatasetsFolder = "";
        DatasetManager.Sync();
        DatasetManager.ExtensionFolder = oldExtension;
        DatasetManager.DatasetsFolder = oldFolder;
        if (!string.IsNullOrWhiteSpace(oldFolder)) DatasetManager.Sync();
        Directory.Delete(root, true);
    }
}
