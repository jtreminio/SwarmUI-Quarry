using System.IO;
using System.Text.Json;
using DuckDB.NET.Data;
using Xunit;

namespace Quarry.Tests;

[Collection("OutputColumns")]
public class ColumnValueProfileTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "quarry-values-" + Guid.NewGuid().ToString("N"));

    public ColumnValueProfileTests() => Directory.CreateDirectory(_root);
    public void Dispose() => Directory.Delete(_root, recursive: true);

    private string Write(string name, IEnumerable<string> values)
    {
        string path = Path.Combine(_root, name + ".jsonl");
        File.WriteAllLines(path, values.Select(value => JsonSerializer.Serialize(new { value })));
        return path;
    }

    [Fact]
    public void EntireColumnIsCheckedBeyondPreviewRows()
    {
        string longPath = Write("long", Enumerable.Repeat("short", 600).Append(new string('x', 256)));
        string distinctPath = Write("distinct", Enumerable.Repeat("a", 600).Concat(["b", "c"]));
        using DuckDbQueryBackend backend = new();
        Assert.Equal("length_limit", backend.ProfileColumn(longPath, "value", new(10000, 256)).Reason);
        Assert.Equal("distinct_limit", backend.ProfileColumn(distinctPath, "value", new(3, 256)).Reason);
    }

    [Fact]
    public void LimitsAreStrictAndUnicodeLengthCountsCharacters()
    {
        using DuckDbQueryBackend backend = new();
        string path = Write("unicode", ["😀a", "😀a", "猫", null, ""]);
        ColumnValueProfile profile = backend.ProfileColumn(path, "value", new(3, 3, 100));
        Assert.True(profile.Eligible);
        Assert.Equal(2, profile.Values.Count);
        Assert.Equal(5, profile.TotalRows);
        Assert.Equal("length_limit", backend.ProfileColumn(path, "value", new(3, 2, 100)).Reason);
        Assert.Equal("distinct_limit", backend.ProfileColumn(path, "value", new(2, 3, 100)).Reason);
    }

    [Fact]
    public void DistinctPercentageUsesAllRowsAndAllowsTheBoundary()
    {
        ColumnValueProfile at = ColumnValueProfile.Analyze(["a", "b", "a", null, ""], new(20, 20, 40));
        Assert.True(at.Eligible);
        ColumnValueProfile over = ColumnValueProfile.Analyze(["a", "b", "c", null, ""], new(20, 20, 40));
        Assert.Equal("percentage_limit", over.Reason);
        Assert.Equal(3, over.DistinctCount);
        Assert.Empty(over.Values);
        Assert.Equal("empty", ColumnValueProfile.Analyze([null, ""], new(20, 20)).Reason);
    }

    [Fact]
    public void UniqueShortTextCanQualifyWithoutAnySampleRepetition()
    {
        ColumnValueProfile profile = ColumnValueProfile.Analyze(["a", "b", "c"], new(4, 2, 100));
        Assert.True(profile.Eligible);
        Assert.Equal(new[] { "a", "b", "c" }, profile.Values);
    }

    [Fact]
    public void CaseVariantsRemainDistinctAndWhitespaceIsNotTrimmed()
    {
        ColumnValueProfile profile = ColumnValueProfile.Analyze(["Ann", "ann", " ann ", ""], new(4, 6, 100));
        Assert.True(profile.Eligible);
        Assert.Equal(3, profile.DistinctCount);
        Assert.Contains(" ann ", profile.Values);
    }

    [Fact]
    public void EarlyRejectionDoesNotConsumeTheRestOfTheColumn()
    {
        static IEnumerable<string> Values()
        {
            yield return "too long";
            throw new InvalidOperationException("Should not need another row");
        }
        Assert.Equal("length_limit", ColumnValueProfile.Analyze(Values(), new(100, 3)).Reason);
    }

    [Fact]
    public void CasingStorageIsRestoredBeforeCheckingDistinctValues()
    {
        using (DuckDBConnection conn = new("DataSource=:memory:"))
        {
            conn.Open();
            using DuckDBCommand cmd = conn.CreateCommand();
            cmd.CommandText = $"INSTALL lance; LOAD lance; ATTACH {SqlText.QuoteLiteral(_root)} AS test (TYPE lance); CREATE TABLE test.main.cases (value VARCHAR, value__case BLOB); INSERT INTO test.main.cases VALUES ('ann', from_hex('5300')), ('ann', from_hex('')); DETACH test;";
            cmd.ExecuteNonQuery();
        }
        string path = Path.Combine(_root, "cases.lance");
        File.WriteAllText(Path.Combine(path, CasingStorage.DescriptorName), """{"version":1,"columns":{"value":"value__case"}}""");
        using DuckDbQueryBackend backend = new();
        Assert.Equal("distinct_limit", backend.ProfileColumn(path, "value", new(2, 10, 100)).Reason);
        Assert.Equal(new[] { "Ann", "ann" }, backend.ProfileColumn(path, "value", new(3, 10, 100)).Values);
    }

    [Fact]
    public void CacheSurvivesRestartAndInvalidatesForDataAndEveryLimit()
    {
        string path = Write("cached", ["a"]);
        string folder = Path.Combine(_root, "cache");
        int calls = 0;
        ColumnValueProfile Build() { calls++; return new(true, "", ["a"], 1, 1); }
        ColumnProfileCache cache = new(folder);
        cache.Get(path, "value", new(10, 10, 100), Build);
        new ColumnProfileCache(folder).Get(path, "value", new(10, 10, 100), Build);
        Assert.Equal(1, calls);
        cache.Get(path, "value", new(11, 10, 100), Build);
        cache.Get(path, "value", new(11, 11, 100), Build);
        cache.Get(path, "value", new(11, 11, 50), Build);
        Assert.Equal(4, calls);
        File.AppendAllText(path, "\n{\"value\":\"changed\"}\n");
        cache.Get(path, "value", new(11, 11, 50), Build);
        Assert.Equal(5, calls);
    }

    [Fact]
    public void CacheDoesNotPublishResultsIfDatasetChangesDuringScan()
    {
        string path = Write("changing", ["a"]);
        ColumnProfileCache cache = new(Path.Combine(_root, "cache"));
        Assert.Throws<QueryException>(() => cache.Get(path, "value", new(10, 10), () =>
        {
            File.AppendAllText(path, "\n{\"value\":\"new\"}\n");
            return new(true, "", ["a"]);
        }));
        bool rebuilt = false;
        cache.Get(path, "value", new(10, 10), () => { rebuilt = true; return new(false, "distinct_limit", []); });
        Assert.True(rebuilt);
    }

    [Theory]
    [InlineData(1, 256, 10)]
    [InlineData(10000, 1, 10)]
    [InlineData(10000, 256, 0)]
    [InlineData(10000, 256, 101)]
    public void InvalidLimitsFailBeforeScanning(int n, int m, double percent)
        => Assert.Throws<QueryException>(() => ColumnValueProfile.Analyze([], new(n, m, percent)));
}
