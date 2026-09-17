using System.IO;
using System.IO.Compression;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Quarry.Tests;

/// <summary>The fixture was produced by quarry prep, including its actual v2 descriptor/indexes.</summary>
public sealed class NestedStorageQueryTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "quarry-nested-storage-" + Guid.NewGuid().ToString("N"));
    private readonly DuckDbQueryBackend _backend = new();
    private string Stored => Path.Combine(_root, "portraits.lance");
    private string Source => Path.Combine(_root, "portraits.jsonl");

    public NestedStorageQueryTests()
        => ZipFile.ExtractToDirectory(Path.Combine(AppContext.BaseDirectory, "Fixtures", "lance-structured-v2.zip"), _root);

    private SqlFilter Plan(string text, string path)
    {
        Query query = QueryParser.Parse(text);
        return NestedQueryCompiler.Build(query, _backend.GetSchema(path), [], query.PromptColumns);
    }

    [Theory]
    [InlineData("p[prompt[i].hair=blond;prompt[i].eyes=blue]:prompt[i]", true)]
    [InlineData("p[prompt[i].hair=blond;prompt[n].hair=red]:prompt[i],prompt[n]|keys;rs=\" = \"", true)]
    [InlineData("p[prompt[].hair=blond;prompt[].eyes!=brown]:prompt[]", true)]
    [InlineData("p[prompt[].hair=a-b]:prompt[]", false)]
    [InlineData("p[prompt[].hair=CAFÉblond]:prompt[]", true)]
    [InlineData("p[prompt[].hair=blond,a-b]:prompt[]", false)]
    [InlineData("p[prompt[].hair==blond,a-b]:prompt[]", true)]
    [InlineData("p[prompt[].hair!=blond]:style", false)]
    [InlineData("p[prompt[1].hair=red]:prompt[0],style", true)]
    [InlineData("p[prompt[i]=blue]:prompt[i]", true)]
    [InlineData("p[prompt[].hair=nomatch]:prompt[]", true)]
    [InlineData("p[style=photo;prompt[].hair!=black]:prompt[]", true)]
    [InlineData("p[id+=3]:prompt[]", true)]
    [InlineData("p[prompt+=2]:prompt[]", false)]
    [InlineData("p[prompt-=0]:style", false)]
    [InlineData("p[prompt+=2;prompt[i].hair=blond]:prompt[]", true)]
    [InlineData("p[prompt+=2;prompt[i].hair=blond;prompt[n].hair=red]:prompt[i],prompt[n]", true)]
    [InlineData("p[prompt.hair=blond;prompt.eyes=blue]:prompt", true)]
    [InlineData("p[prompt[].hair=blond;prompt[].eyes=blue]:prompt[]", true)]
    [InlineData("p[prompt[*].hair=blond;prompt[*].eyes=blue]:prompt[*]", true)]
    [InlineData("p[prompt[]+=2]:prompt", false)]
    [InlineData("p[prompt[*]+=2]:prompt[*]", false)]
    [InlineData("p:prompt", false)]
    [InlineData("p:prompt[]", false)]
    public void PreparedIndexAndExactSourceAgreeEveryReadPath(string text, bool indexed)
    {
        Query query = QueryParser.Parse(text);
        SqlFilter prepared = Plan(text, Stored), scan = Plan(text, Source);
        Assert.Equal(indexed, prepared.CandidateWhereClause.Length > 0);
        long count = _backend.CountRows(Source, scan);
        Assert.Equal(count, _backend.CountRows(Stored, prepared));
        Assert.Equal(_backend.GetPrompts(Source, query.PromptColumns, scan, 20, 0),
            _backend.GetPrompts(Stored, query.PromptColumns, prepared, 20, 0));
        for (long i = 0; i < count; i++)
        {
            Assert.Equal(_backend.GetPromptAt(Source, query.PromptColumns, scan, i),
                _backend.GetPromptAt(Stored, query.PromptColumns, prepared, i));
        }
        // Physical-row rejection sampling must not address filtered candidate offsets.
        Random random = new(12345);
        for (int i = 0; i < 12; i++)
        {
            long ordinal = random.NextInt64(8);
            Assert.Equal(_backend.GetCandidateAt(Source, query.PromptColumns, scan, ordinal),
                _backend.GetCandidateAt(Stored, query.PromptColumns, prepared, ordinal));
        }
    }

    [Fact]
    public void HelpersAreHiddenAndFlatCasingIsRestored()
    {
        ColumnSchema schema = _backend.GetSchema(Stored);
        Assert.Equal(new[] { "prompt", "style", "id" }, schema.VisibleColumns.Select(c => c.Name));
        Assert.Equal(2, schema.SearchHelpers.Count);
        Assert.Equal(new[] { "prompt", "style", "id" }, _backend.GetSampleRows(Stored, 8).Columns);
        Assert.Equal("Photo", _backend.GetSampleRows(Stored, 1).Rows[0][1]);
        Assert.DoesNotContain(_backend.GetFilteredRows(Stored, [], SqlFilter.None, null, false, 8, 0).Columns,
            c => c.StartsWith("__quarry_search_"));
        Assert.Throws<QueryException>(() => _backend.GetPrompts(Stored, ["__quarry_search_0"], SqlFilter.None, 1, 0));
    }

    [Fact]
    public void UntrustedUnencodedSnapshotDisablesPreviouslyCompiledCandidates()
    {
        // Remove encoded flat fields from the logical descriptor for this fixture-only
        // check; output uses native original nested records exclusively.
        string file = Path.Combine(Stored, CasingStorage.DescriptorName);
        JObject descriptor = JObject.Parse(File.ReadAllText(file));
        descriptor["columns"] = new JObject();
        File.WriteAllText(file, descriptor.ToString());
        const string query = "p[prompt[i].hair=blond;prompt[i].eyes=blue]:prompt[i]";
        SqlFilter prepared = Plan(query, Stored), scan = Plan(query, Source);
        Assert.NotEmpty(prepared.CandidateWhereClause);
        descriptor["snapshot"]["sha256"] = new string('0', 64);
        File.WriteAllText(file, descriptor.ToString());
        Assert.Empty(_backend.GetSchema(Stored).SearchHelpers);
        Assert.Equal(_backend.CountRows(Source, scan), _backend.CountRows(Stored, prepared));
        Assert.Equal(_backend.GetPrompts(Source, ["prompt[i]"], scan, 20, 0),
            _backend.GetPrompts(Stored, ["prompt[i]"], prepared, 20, 0));
        Assert.DoesNotContain(_backend.GetSampleRows(Stored, 1).Columns, c => c.StartsWith("__quarry_search_"));
    }

    [Fact]
    public void ChangedEncodedSnapshotFailsEvenForCountOnlyReads()
    {
        SqlFilter compiled = Plan("p[prompt[i].hair=blond]:prompt[i]", Stored);
        string file = Path.Combine(Stored, CasingStorage.DescriptorName);
        JObject descriptor = JObject.Parse(File.ReadAllText(file));
        descriptor["snapshot"]["sha256"] = new string('0', 64);
        File.WriteAllText(file, descriptor.ToString());
        Assert.Throws<InvalidDataException>(() => _backend.CountRows(Stored, compiled));
        Assert.Throws<InvalidDataException>(() => _backend.GetSampleRows(Stored, 1));
    }

    public void Dispose()
    {
        _backend.Dispose();
        Directory.Delete(_root, true);
    }
}
