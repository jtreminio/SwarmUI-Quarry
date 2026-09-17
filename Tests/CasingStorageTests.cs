using System.IO;
using System.IO.Compression;
using System.Text;
using DuckDB.NET.Data;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Quarry.Tests;

[Collection("OutputColumns")]
public class CasingStorageTests
{
    private static JArray Fixtures => JArray.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "casing-v1.json")));

    [Fact]
    public void PythonFormat22MiniblocksAreReadableByQuarry()
    {
        string root = Path.Combine(Path.GetTempPath(), "quarry-lance22-" + Guid.NewGuid().ToString("N"));
        try
        {
            ZipFile.ExtractToDirectory(Path.Combine(AppContext.BaseDirectory, "Fixtures", "lance-v22.zip"), root);
            string path = Path.Combine(root, "sample.lance");
            JObject expected = JObject.Parse(File.ReadAllText(Path.Combine(root, "expected.json")));
            using DuckDbQueryBackend backend = new();
            ColumnSchema schema = backend.GetSchema(path);
            Assert.Equal(new[] { "prompt", "tags" }, schema.VisibleColumns.Select(c => c.Name));
            Assert.All(schema.VisibleColumns, c => Assert.True(c.HasNgramIndex));
            Assert.Equal(6, backend.CountRows(path, SqlFilter.None));
            var sample = backend.GetSampleRows(path, 6);
            Assert.Equal(6, sample.Rows.Count);
            for (int row = 0; row < 6; row++)
            {
                Assert.Equal(expected["prompt"][row].Value<string>() ?? "", sample.Rows[row][0]);
                Assert.Equal(expected["tags"][row].Value<string>() ?? "", sample.Rows[row][1]);
            }
            foreach (string term in new[] { "BLUE", "ÉTÉ", "猫" })
            {
                SqlFilter filter = SqlFilterBuilder.Build(QueryParser.Parse($"sample[prompt={term}]"), schema);
                Assert.Equal(1, backend.CountRows(path, filter));
            }
            Assert.Equal("Blue CAT, Art", backend.GetPromptAt(path, ["prompt", "tags"], SqlFilter.None, 0));
            Query formatted = QueryParser.Parse("sample:prompt,tags|keys;rs=\" = \"");
            SqlFilter formattedFilter = NestedQueryCompiler.Build(formatted, schema, [], formatted.PromptColumns);
            Assert.Equal("prompt: Blue CAT = tags: Art", backend.GetPromptAt(path, formatted.PromptColumns, formattedFilter, 0));
            Assert.Equal(("prompt: Blue CAT = tags: Art", true), backend.GetCandidateAt(path, formatted.PromptColumns, formattedFilter, 0));
            Assert.NotEmpty(backend.GetPrompts(path, formatted.PromptColumns, formattedFilter, 10, 0));
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, true);
            }
        }
    }

    [Fact]
    public void SharedPythonFixtures_RestoreExactOriginalUtf8()
    {
        foreach (JToken fixture in Fixtures)
        {
            string patch = fixture.Value<string>("patch");
            Assert.Equal(fixture.Value<string>("original"), CasingStorage.Restore(
                fixture.Value<string>("lower"), patch is null ? null : Convert.FromHexString(patch)));
        }
    }

    [Theory]
    [InlineData("a", null)]
    [InlineData(null, "")]
    [InlineData("a", "3f")]
    [InlineData("a", "5380")]
    [InlineData("a", "5302")]
    [InlineData("a", "530000")]
    [InlineData("é", "5300")]
    [InlineData("a", "4280")]
    [InlineData("a", "42")]
    public void InvalidPatchesFailClosed(string lower, string hex)
        => Assert.Throws<InvalidDataException>(() => CasingStorage.Restore(lower, hex is null ? null : Convert.FromHexString(hex)));

    [Fact]
    public void InvalidUtf8IsRejected()
        => Assert.Throws<DecoderFallbackException>(() => CasingStorage.Restore("a", [70, 255]));

    [Fact]
    public void IndexedSearchAndEveryOutputPathUseCasingStorage()
    {
        string root = Path.Combine(Path.GetTempPath(), "quarry-casing-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        string path = Path.Combine(root, "sample.lance");
        try
        {
            using (DuckDBConnection connection = new("DataSource=:memory:"))
            {
                connection.Open();
                using DuckDBCommand command = connection.CreateCommand();
                command.CommandText = $"INSTALL lance; LOAD lance; ATTACH {SqlText.QuoteLiteral(root)} AS casing (TYPE lance);";
                command.ExecuteNonQuery();
                command.CommandText = "CREATE TABLE casing.main.sample (prompt VARCHAR, tags VARCHAR, score BIGINT, prompt__case BLOB, tags__case BLOB);";
                command.ExecuteNonQuery();
                command.CommandText = "INSERT INTO casing.main.sample VALUES ('blue cat', 'art', 1, from_hex('530005'), from_hex('5300')), ('été', 'photo', 2, from_hex('46C38974C3A9'), from_hex('5300')), (NULL, NULL, 3, NULL, NULL), ('😀a cat', 'emoji', 4, from_hex('530402'), from_hex('')), ('猫猫猫', 'unicode', 5, from_hex(''), from_hex(''));";
                command.ExecuteNonQuery();
                command.CommandText = "CREATE INDEX prompt_idx ON casing.main.sample (prompt) USING NGRAM; CREATE INDEX tags_idx ON casing.main.sample (tags) USING NGRAM; DETACH casing;";
                command.ExecuteNonQuery();
            }
            File.WriteAllText(Path.Combine(path, CasingStorage.DescriptorName), """
                {"version":1,"columns":{"prompt":"prompt__case","tags":"tags__case"}}
                """);
            using DuckDbQueryBackend backend = new();
            ColumnSchema schema = backend.GetSchema(path);
            Assert.Equal(new[] { "prompt", "tags", "score" }, schema.VisibleColumns.Select(c => c.Name));
            Assert.True(schema.TryGet("prompt", out ColumnInfo prompt));
            Assert.True(prompt.HasNgramIndex);
            Assert.Equal("prompt__case", prompt.CasingColumn);
            SqlFilter filter = SqlFilterBuilder.Build(QueryParser.Parse("sample[prompt=BLUE]"), schema);
            Assert.Contains("contains(\"prompt\", lower($p0))", filter.WhereClause);
            Assert.Equal(1, backend.CountRows(path, filter));
            schema.TryGet("tags", out ColumnInfo tags);
            SqlFilter merged = SqlFilterBuilder.Build(QueryParser.Parse("sample[tags=ART]"), schema, [prompt, tags]);
            SqlFilter shortTerm = SqlFilterBuilder.Build(QueryParser.Parse("sample[prompt=lu]"), schema);
            Assert.Contains("contains(lower(\"prompt\"), lower($p0))", shortTerm.WhereClause);
            Assert.Equal(1, backend.CountRows(path, shortTerm));
            Assert.Single(merged.Parameters);
            Assert.Equal(1, backend.CountRows(path, merged));
            // A mixed legacy/encoded configuration must bind both parameters.
            SqlFilter mixed = SqlFilterBuilder.Build(QueryParser.Parse("sample[tags=art]"), schema,
                [prompt, new ColumnInfo("tags", ColumnKind.Scalar)]);
            Assert.Equal(2, mixed.Parameters.Count);
            Assert.Equal(1, backend.CountRows(path, mixed));
            Assert.Equal("Blue Cat, Art", backend.GetPromptAt(path, ["prompt", "tags"], filter, 0));
            Assert.Equal(("Été, Photo", false), backend.GetCandidateAt(path, ["prompt", "tags"], filter, 1));
            Assert.Equal(("Blue Cat, Art", true), backend.GetCandidateAt(path, ["prompt", "tags"], filter, 0));
            var sample = backend.GetSampleRows(path, 3);
            Assert.Equal(new[] { "prompt", "tags", "score" }, sample.Columns);
            Assert.Equal(new[] { "Été", "Photo", "2" }, sample.Rows[1]);
            Assert.Equal(new[] { "", "", "3" }, sample.Rows[2]);
            var filtered = backend.GetFilteredRows(path, ["tags", "prompt"], filter, null, false, 10, 0);
            Assert.Equal(new[] { "tags", "prompt" }, filtered.Columns);
            Assert.Equal(new[] { "Art", "Blue Cat" }, filtered.Rows[0]);
            SqlFilter unicode = SqlFilterBuilder.Build(QueryParser.Parse("sample[prompt=ÉTÉ]"), schema);
            Assert.Equal("Été", backend.GetPromptAt(path, ["prompt"], unicode, 0));
            foreach (string term in new[] { "😀A", "猫猫猫" })
            {
                SqlFilter unicodeTerm = SqlFilterBuilder.Build(QueryParser.Parse($"sample[prompt={term}]"), schema);
                Assert.Contains("contains(lower(\"prompt\"),", unicodeTerm.WhereClause);
                Assert.Equal(1, backend.CountRows(path, unicodeTerm));
            }
            Assert.Throws<QueryException>(() => backend.GetPromptAt(path, ["prompt__case"], SqlFilter.None, 0));
            Assert.Throws<QueryException>(() => SqlFilterBuilder.Build(QueryParser.Parse("sample[prompt__case=x]"), schema));
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Fact]
    public void UnknownFormatsAndCollidingMappingsAreRejected()
    {
        string root = Path.Combine(Path.GetTempPath(), "quarry-descriptor-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            foreach (string json in new[] { "{\"version\":99,\"columns\":{}}", "{\"version\":1,\"columns\":{\"a\":\"wrong\"}}", "{\"version\":1,\"columns\":{\"a\":\"a__case\",\"a__case\":\"a__case__case\"}}" })
            {
                File.WriteAllText(Path.Combine(root, CasingStorage.DescriptorName), json);
                Assert.Throws<InvalidDataException>(() => CasingStorage.Load(root));
            }
        }
        finally { Directory.Delete(root, true); }
    }
}
