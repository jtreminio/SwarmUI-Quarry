using System.IO;
using DuckDB.NET.Data;
using Xunit;

namespace Quarry.Tests;

public sealed class JsonSourceSchemaTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "quarry-json-schema-" + Guid.NewGuid().ToString("N"));

    public JsonSourceSchemaTests() => Directory.CreateDirectory(_root);
    public void Dispose() => Directory.Delete(_root, true);

    private string Write(string text, string extension = ".jsonl")
    {
        string path = Path.Combine(_root, "source" + extension);
        File.WriteAllText(path, text);
        return path;
    }

    private static List<object[]> Read(string path)
    {
        using DuckDBConnection connection = new("Data Source=:memory:");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT * FROM " + DatasetSource.Resolve(path).FromExpression;
        using var reader = command.ExecuteReader();
        List<object[]> rows = [];
        while (reader.Read())
        {
            object[] values = new object[reader.FieldCount];
            reader.GetValues(values);
            rows.Add(values);
        }
        return rows;
    }

    [Theory]
    [InlineData(".json")]
    [InlineData(".jsonl")]
    [InlineData(".ndjson")]
    public void ExplicitTypesPreserveDateTextAndExactUnsignedIntegers(string extension)
    {
        const string row = "{\"prompt\":\"2026-09-16\",\"id\":18446744073709551615,\"nothing\":null}";
        string path = Write(extension == ".json" ? "[" + row + "]" : row, extension);
        object[] values = Assert.Single(Read(path));
        Assert.Equal("2026-09-16", values[0]);
        Assert.Equal(ulong.MaxValue, values[1]);
        Assert.Equal(DBNull.Value, values[2]);
        Assert.Contains("auto_detect = false", DatasetSource.Resolve(path).FromExpression);
    }

    [Fact]
    public void DiscoveryIncludesLateFieldsAndPreservesFirstSeenOrder()
    {
        string path = Write(string.Concat(Enumerable.Repeat("{\"prompt\":[{\"z\":\"first\"}]}\n", 20500))
            + "{\"prompt\":[{\"a\":\"late\",\"z\":\"last\"}]}\n");
        var rows = Read(path);
        var record = Assert.Single(Assert.IsType<List<Dictionary<string, object>>>(rows[^1][0]));
        Assert.Equal(new[] { "z", "a" }, record.Keys);
        Assert.Equal("late", record["a"]);
    }

    [Fact]
    public void SupportsJsonObjectAndLegacyScalarLists()
    {
        var row = Assert.Single(Read(Write("{\"prompt\":\"test\",\"tags\":[\"2026-09-16\",null,\"UPPER\"],\"meta\":{\"when\":\"2026-09-16\"}}", ".json")));
        Assert.Equal(new[] { "2026-09-16", null, "UPPER" }, Assert.IsType<List<string>>(row[1]));
        Assert.Equal("2026-09-16", Assert.IsType<Dictionary<string, object>>(row[2])["when"]);
    }

    [Fact]
    public void UnknownElementArraysRemainLegacyNullableTextLists()
    {
        string path = Write("{\"prompt\":\"first\",\"tags\":[]}\n{\"prompt\":\"second\",\"tags\":[null]}");
        var rows = Read(path);
        Assert.Equal(2, rows.Count);
        Assert.Equal("first", rows[0][0]);
        Assert.Empty(Assert.IsType<List<string>>(rows[0][1]));
        Assert.Null(Assert.Single(Assert.IsType<List<string>>(rows[1][1])));
        Assert.Contains("'tags': 'VARCHAR[]'", DatasetSource.Resolve(path).FromExpression);
    }

    [Theory]
    [InlineData("{\"prompt\":[{\"age\":1}]}\n{\"prompt\":[{\"age\":1.5}]}", "prompt[].age")]
    [InlineData("{\"prompt\":{\"age\":true}}\n{\"prompt\":{\"age\":1}}", "prompt.age")]
    [InlineData("{\"prompt\":{\"age\":18446744073709551616}}", "prompt.age")]
    [InlineData("{\"prompt\":{\"age\":1e999}}", "prompt.age")]
    [InlineData("{\"prompt\":{\"age\":-1}}\n{\"prompt\":{\"age\":18446744073709551615}}", "prompt.age")]
    [InlineData("{\"prompt\":{\"age\":[1]}}", "prompt.age")]
    [InlineData("{\"prompt\":{\"meta\":{\"age\":1}}}", "prompt.meta")]
    [InlineData("{\"prompt\":[[\"text\"]]}", "prompt[]")]
    [InlineData("{\"prompt\":{\"age\":1,\"Age\":2}}", "prompt.Age")]
    [InlineData("{\"prompt\":{\"age\":1}}\n{\"prompt\":{\"Age\":2}}", "prompt.Age")]
    public void InvalidKindsAndShapesFailWithFieldPath(string json, string expectedPath)
    {
        var error = Assert.Throws<QueryException>(() => DatasetSource.Resolve(Write(json)));
        Assert.Contains(expectedPath, error.Message);
    }

    [Fact]
    public void CacheInvalidatesWhenFileChanges()
    {
        string path = Write("{\"prompt\":\"original\"}");
        string first = DatasetSource.Resolve(path).FromExpression;
        Assert.Equal(first, DatasetSource.Resolve(path).FromExpression);
        File.WriteAllText(path, "{\"prompt\":\"modified\",\"added\":true}");
        Assert.NotEqual(first, DatasetSource.Resolve(path).FromExpression);
        Assert.Equal(true, Assert.Single(Read(path))[1]);
    }

    [Fact]
    public void AllEmptyComplexPromptExposesZeroRowsWithoutInventingFields()
    {
        string path = Write("{\"prompt\":[{}]}\n{\"prompt\":[]}\n{\"prompt\":[null]}");
        Assert.Empty(Read(path));
        Assert.Contains("CAST(NULL AS VARCHAR)", DatasetSource.Resolve(path).FromExpression);
    }

    [Fact]
    public void SchemaLessNonpromptObjectHasActionableError()
    {
        var error = Assert.Throws<QueryException>(() => DatasetSource.Resolve(Write("{\"prompt\":\"text\",\"meta\":{}}")));
        Assert.Contains("omit this column", error.Message);
    }
}
