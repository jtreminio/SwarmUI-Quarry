using System.IO;
using DuckDB.NET.Data;
using Quarry;
using Xunit;

namespace Quarry.Tests;

public sealed class NestedQueryTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "quarry-nested-" + Guid.NewGuid().ToString("N"));
    private readonly DuckDbQueryBackend _backend = new();
    private readonly string _path;

    public NestedQueryTests()
    {
        Directory.CreateDirectory(_root);
        _path = Path.Combine(_root, "portraits.jsonl");
        File.WriteAllText(_path, """
            {"id":1,"style":"Photo","subject":[{"hair":"blond","eyes":"blue"},{"hair":"red","eyes":"green"}],"meta":{"mood":"warm","score":2}}
            {"id":2,"style":"Sketch","subject":[{"hair":"blond","eyes":"brown"},{"hair":"black","eyes":"blue"}],"meta":{"mood":"soft","score":3}}
            {"id":3,"style":"Painting","subject":[{"hair":"blond red","eyes":"blue green"}],"meta":{"mood":null,"score":0}}
            {"id":4,"style":"Empty","subject":[],"meta":null}
            {"id":5,"style":"Null","subject":null,"meta":null}
            {"id":6,"style":"Backtrack","subject":[{"hair":"blond red","eyes":"blue green"},{"hair":"blond","eyes":"blue"}],"meta":null}
            """);
    }

    private (SqlFilter Filter, IReadOnlyList<string> Columns) Plan(string text, string path = null)
    {
        Query query = QueryParser.Parse(text);
        ColumnSchema schema = _backend.GetSchema(path ?? _path);
        var columns = PromptColumnResolver.ResolveOutputColumns(query.PromptColumns, "style", schema);
        return (NestedQueryCompiler.Build(query, schema, [], columns), columns);
    }

    private List<string> Run(string text, string path = null)
    {
        var (filter, columns) = Plan(text, path);
        return _backend.GetPrompts(path ?? _path, columns, filter, 100, 0);
    }

    [Fact]
    public void Parser_BalancesSelectorsAndPreservesQuotedSeparators()
    {
        Query query = QueryParser.Parse("portraits[subject[i].hair=blond; subject[n].eyes=green]:subject[i], subject[n]|keys; rs=\" = ; | [] \\\"\"; fs=\", \"");
        Assert.Equal("portraits", query.Name);
        Assert.Equal(new[] { "subject[i]", "subject[n]" }, query.PromptColumns);
        Assert.True(query.Format.Keys);
        Assert.Equal(" = ; | [] \"", query.Format.RecordSeparator);
        Assert.Equal(", ", query.Format.FieldSeparator);
    }

    [Theory]
    [InlineData("p:s|rs=unquoted")]
    [InlineData("p:s|rs=null")]
    [InlineData("p:s|keys=true")]
    [InlineData("p:s|rs=\",\";record_separator=\";\"")]
    [InlineData("p:s|fs=\"unfinished")]
    [InlineData("p[subject[i].hair=x:subject[i]")]
    public void InvalidSyntax_HasActionableError(string query)
        => Assert.Throws<QueryParseException>(() => QueryParser.Parse(query));

    [Fact]
    public void ArrayCounts_ExcludeNullSlotsAndPreserveEveryReadPath()
    {
        File.WriteAllText(_path, """
            {"style":"Null","prompt":null}
            {"style":"Empty","prompt":[]}
            {"style":"NullSlot","prompt":[null]}
            {"style":"Blank","prompt":[{"subject":null}]}
            {"style":"One","prompt":[null,{"subject":"A"},null]}
            {"style":"Two","prompt":[{"subject":"A"},null,{"subject":"B"}]}
            {"style":"Three","prompt":[{"subject":"A"},{"subject":"B"},{"subject":"C"}]}
            """);
        Assert.Equal(new[] { "Two", "Three" }, Run("p[prompt+=2]:style"));
        Assert.Equal(new[] { "Null", "Empty", "NullSlot" }, Run("p[prompt-=0]:style"));
        Assert.Equal(new[] { "Blank", "One" }, Run("p[prompt+=1;prompt-=1]:style"));
        Assert.Equal(new[] { "Two" }, Run("p[prompt+=2;prompt-=2]:style"));
        Assert.Equal(new[] { "A, B", "A, B, C" }, Run("p[prompt+=2]:prompt[]"));
        Assert.Empty(Run("p[prompt-=0]:prompt[]"));
        Assert.Equal(new[] { "A, B", "A, B, C" }, Run("p[prompt+=2]:prompt"));
        Assert.Equal(new[] { "A", "A" }, Run("p[prompt+=2]:prompt[0]"));
        Assert.Equal(Run("p[prompt+=2]:prompt"), Run("p[prompt[]+=2]:prompt[]"));
        var (filter, columns) = Plan("p[prompt+=2]:prompt[]");
        Assert.Equal(2, _backend.CountRows(_path, filter));
        Assert.Equal(new[] { "A, B, C" }, _backend.GetPrompts(_path, columns, filter, 1, 1));
        Assert.Equal("A, B", _backend.GetPromptAt(_path, columns, filter, 0));
        Assert.False(_backend.GetCandidateAt(_path, columns, filter, 4).Matches);
        Assert.Equal(("A, B", true), _backend.GetCandidateAt(_path, columns, filter, 5));
    }

    [Theory]
    [InlineData("+=1.1", 3)]
    [InlineData("-=1.9", 3)]
    [InlineData("+=2e0", 3)]
    [InlineData("+=bad", 0)]
    [InlineData("+=999999999999999999999999", 0)]
    [InlineData("-=-1", 0)]
    [InlineData("+=-1", 6)]
    [InlineData("+=2,1", 4)]
    public void ArrayCounts_UseExistingComparisonBounds(string comparison, int expected)
    {
        Assert.Equal(expected, Run($"p[subject{comparison}]:style").Count);
    }

    [Theory]
    [InlineData("p[subject[0]+=2]:style")]
    [InlineData("p[subject[i]+=2]:style")]
    [InlineData("p[subject.hair+=2]:style")]
    [InlineData("p[subject[].hair+=2]:style")]
    [InlineData("p[meta+=2]:style")]
    public void ArrayCounts_RequireAnArrayColumnRatherThanARecordSelection(string text)
    {
        Assert.Throws<QueryException>(() => Plan(text));
    }

    [Theory]
    [InlineData("jsonl")]
    [InlineData("lance")]
    public void ScalarArrayCounts_WorkWithAndWithoutNestedOutput(string format)
    {
        File.WriteAllText(_path, """
            {"style":"Two","values":["",null,"red"],"subject":[{"hair":"red"}]}
            {"style":"One","values":[null,"red"],"subject":[{"hair":"brown"}]}
            {"style":"Empty","values":[],"subject":null}
            {"style":"Null","values":null,"subject":null}
            """);
        string target = _path;
        if (format == "lance")
        {
            target = Path.Combine(_root, "scalar.lance");
            using DuckDBConnection con = new("DataSource=:memory:");
            con.Open();
            using var cmd = con.CreateCommand();
            cmd.CommandText = $"INSTALL lance; LOAD lance; ATTACH {SqlText.QuoteLiteral(_root)} AS scalar_storage (TYPE lance); CREATE TABLE scalar_storage.main.scalar AS SELECT * FROM read_ndjson({SqlText.QuoteLiteral(_path)}); DETACH scalar_storage;";
            cmd.ExecuteNonQuery();
        }
        Assert.Equal(new[] { "Two" }, Run("p[values+=2]:style", target));
        Assert.Equal(new[] { "Empty", "Null" }, Run("p[values-=0]:style", target));
        Assert.Equal(new[] { "red" }, Run("p[values+=2]:subject[]", target));
        var (filter, columns) = Plan("p[values+=2]:style", target);
        Assert.Equal(1, _backend.CountRows(target, filter));
        Assert.Equal("Two", _backend.GetPromptAt(target, columns, filter, 0));
        Assert.Equal(("Two", true), _backend.GetCandidateAt(target, columns, filter, 0));
        Assert.False(_backend.GetCandidateAt(target, columns, filter, 1).Matches);
    }

    [Fact]
    public void MergedTagCounts_CompareArraysSeparatelyWithOtherPredicates()
    {
        File.WriteAllText(_path, """
            {"style":"OneEach","subject":[{"hair":"red"}],"labels":["red"]}
            {"style":"TwoRecords","subject":[{"hair":"red"},{"hair":"brown"}],"labels":[]}
            {"style":"TwoLabels","subject":[{"hair":"red"}],"labels":["red","brown"]}
            """);
        ColumnSchema schema = _backend.GetSchema(_path);
        Query query = QueryParser.Parse("p[style=Two;tags+=2;subject[i].hair=red]:style");
        var tags = schema.Columns.Where(c => c.Name is "subject" or "labels").ToArray();
        SqlFilter filter = NestedQueryCompiler.Build(query, schema, tags, ["style"]);
        Assert.Equal(new[] { "TwoRecords", "TwoLabels" }, _backend.GetPrompts(_path, ["style"], filter, 10, 0));
    }

    [Theory]
    [InlineData("STRUCT(hair VARCHAR[])[]")]
    [InlineData("VARCHAR[][]")]
    [InlineData("STRUCT(hair VARCHAR)")]
    public void MergedTagCounts_RejectUnsupportedObjectsAndNesting(string type)
    {
        ColumnInfo tag = new("subject", DuckDbTypeMapper.MapKind(type), dataType: type);
        ColumnSchema schema = new([tag, new("style", ColumnKind.Scalar)]);
        Assert.ThrowsAny<QueryException>(() => NestedQueryCompiler.Build(
            QueryParser.Parse("p[tags+=2]:style"), schema, [tag], ["style"]));
    }

    [Fact]
    public void BoundConditions_MatchSameSubject_AndBareFieldsSearchAllRecords()
    {
        var results = Run("p[subject[i].hair=blond;subject[i].eyes=blue]:subject[i]");
        Assert.Equal(new[] { "blond, blue", "blond red, blue green", "blond red, blue green" }, results);
        Assert.Equal(Run("p[subject.hair=blond]:subject"), Run("p[subject[].hair=blond]:subject[]"));
        Assert.Equal(new[] { "Photo", "Sketch", "Painting", "Backtrack" }, Run("p[subject.hair=blond;subject.eyes=blue]:style"));
        Assert.Equal(new[] { "Photo", "Painting", "Backtrack" }, Run("p[subject[i].hair=blond;subject[i].eyes=blue]:style"));
        Assert.Equal(new[] { "Sketch" }, Run("p[subject.hair=black]:style"));
        Assert.Empty(Run("p[subject[0].hair=black]:style"));
        Assert.Equal(new[] { "blond, brown", "blond red, blue green" }, Run("p[subject[1].hair=black,blond]:subject[0]"));
    }

    [Fact]
    public void DistinctBindings_BacktrackAndPrintFirstCompleteAssignment()
    {
        const string filter = "p[subject[i].hair=blond;subject[i].eyes=blue;subject[n].hair=red;subject[n].eyes=green]";
        Assert.Equal(new[] { "blond, blue = red, green", "blond, blue = blond red, blue green" },
            Run(filter + ":subject[i],subject[n]|rs=\" = \""));
        Assert.Equal(new[] { "blond, blue, red, green", "blond red, blue green, blond, blue" }, Run(filter + ":subject[]"));
        var (sql, columns) = Plan(filter + ":subject[i]");
        Assert.Equal(2, _backend.CountRows(_path, sql));
        Assert.Equal(("blond, blue", true), _backend.GetCandidateAt(_path, columns, sql, 5));
        Assert.False(_backend.GetCandidateAt(_path, columns, sql, 2).Matches);
        Assert.Equal("blond, blue", _backend.GetPromptAt(_path, columns, sql, 1));
    }

    [Fact]
    public void Wildcards_AreIndependentAndNoneMeansNoElementMatches()
    {
        Assert.Equal(4, Run("p[subject[].hair=blond;subject[].eyes=blue]:style").Count);
        Assert.Equal(new[] { "Empty", "Null" }, Run("p[subject[].hair!=blond]:style"));
        Assert.Equal(new[] { "Photo", "Painting", "Backtrack" }, Run("p[subject[].hair==blond,red]:style"));
        Assert.Equal(new[] { "red, green", "black, blue", "blond, blue" }, Run("p:subject[1]"));
        var (sql, _) = Plan("p:subject[1]");
        Assert.Equal(3, _backend.CountRows(_path, sql));
    }

    [Theory]
    [InlineData("")]
    [InlineData("[]")]
    [InlineData("[*]")]
    public void AllRecordAliases_ShareFilteringRenderingAndCounts(string selector)
    {
        string array = "subject" + selector;
        ColumnSchema schema = _backend.GetSchema(_path);
        Assert.Equal(FieldPath.Resolve("subject", schema), FieldPath.Resolve(array, schema));
        Assert.Equal(new[] { "Photo", "Sketch", "Painting", "Backtrack" },
            Run($"p[{array}.hair=blond;{array}.eyes=blue]:style"));
        Assert.Equal(new[] { "Empty", "Null" }, Run($"p[{array}.hair!=blond]:style"));
        Assert.Equal(new[] { "Photo", "Painting", "Backtrack" }, Run($"p[{array}.hair==blond,red]:style"));
        Assert.Equal(new[] { "Photo", "Painting", "Backtrack" }, Run($"p[{array}=red]:style"));
        Assert.Equal(Run("p[subject+=2]:subject|keys;rs=\"; \""), Run($"p[{array}+=2]:{array}|keys;rs=\"; \""));
        Assert.Equal(Run("p:subject.hair"), Run($"p:{array}.hair"));
        Assert.Equal(new[] { "blond, red", "blond, black", "blond red", "blond red, blond" }, Run($"p:{array}.hair"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("[]")]
    [InlineData("[*]")]
    public void ScalarArrayAliases_ShareNullAndOutputSemantics(string selector)
    {
        File.WriteAllText(_path, """
            {"style":"Null","values":null}
            {"style":"Empty","values":[]}
            {"style":"Blank","values":[null,""]}
            {"style":"Colors","values":[null,"Red","Blue"]}
            """);
        string array = "values" + selector;
        Assert.Equal(new[] { "Colors" }, Run($"p[{array}=red]:style"));
        Assert.Equal(new[] { "Null", "Empty", "Blank" }, Run($"p[{array}!=red]:style"));
        Assert.Equal(new[] { "Colors" }, Run($"p[{array}==red,blue]:style"));
        Assert.Equal(new[] { "Null", "Empty" }, Run($"p[{array}-=0]:style"));
        Assert.Equal(new[] { "Red, Blue" }, Run($"p:{array}"));
        Assert.Equal(Run("p:values|keys"), Run($"p:{array}|keys"));
        var (filter, _) = Plan($"p:{array}");
        Assert.Equal(1, _backend.CountRows(_path, filter));
    }

    [Fact]
    public void Formatting_AppliesLabelsAndSeparatorsWithoutChangingSelection()
    {
        Assert.Equal("style: Photo = hair: blond, eyes: blue = hair: red, eyes: green", Run("p[id+=1;id-=1]:style,subject[]|keys;record_separator=\" = \";field_separator=\", \"").Single());
        Assert.Equal("mood: warm; score: 2", Run("p[id+=1;id-=1]:meta|keys;fs=\"; \"").Single());
        Assert.Equal("0", Run("p[id+=3;id-=3]:meta").Single());
        Assert.Equal(new[] { "Photo", "Sketch" }, Run("p[meta.score+=2]:style"));
        Assert.Equal(new[] { "warm2", "soft3", "0" }, Run("p:meta.mood,meta.score|rs=\"\""));
    }

    [Theory]
    [InlineData("p:subject[i]")]
    [InlineData("p:subject[99].missing")]
    [InlineData("p:meta[0]")]
    [InlineData("p:meta[]")]
    [InlineData("p:style[]")]
    [InlineData("p:subject[99999999999999999999]")]
    public void InvalidPaths_DoNotFallBack(string text) => Assert.Throws<QueryException>(() => Plan(text));

    [Theory]
    [InlineData("parquet")]
    [InlineData("lance")]
    public void StorageFormats_PreserveObjectFields(string format)
    {
        string target = Path.Combine(_root, "stored." + format);
        using (DuckDBConnection con = new("DataSource=:memory:"))
        {
            con.Open();
            using var cmd = con.CreateCommand();
            cmd.CommandText = format == "parquet"
                ? $"COPY (SELECT * FROM read_ndjson({SqlText.QuoteLiteral(_path)})) TO {SqlText.QuoteLiteral(target)} (FORMAT PARQUET)"
                : $"INSTALL lance; LOAD lance; ATTACH {SqlText.QuoteLiteral(_root)} AS nested_storage (TYPE lance); CREATE TABLE nested_storage.main.stored AS SELECT * FROM read_ndjson({SqlText.QuoteLiteral(_path)}); DETACH nested_storage;";
            cmd.ExecuteNonQuery();
        }
        Assert.Equal(Run("p[subject[i].hair=blond]:subject[i]|keys"), Run("p[subject[i].hair=blond]:subject[i]|keys", target));
        Assert.Equal(Run("p[subject[i].hair=blond;subject[n].hair=red]:subject[i],subject[n]"), Run("p[subject[i].hair=blond;subject[n].hair=red]:subject[i],subject[n]", target));
        Assert.Equal(Run("p[subject+=2]:subject[]"), Run("p[subject+=2]:subject[]", target));
        var schema = _backend.GetSchema(target);
        Assert.True(schema.TryGet("meta", out var meta));
        Assert.Equal(ColumnKind.Object, meta.Kind);
        Assert.Equal(new[] { "mood", "score" }, meta.Fields.Select(f => f.Name));
    }

    [Theory]
    [InlineData("{\"subject\":[{\"hair\":[\"blond\"]}]}")]
    [InlineData("{\"subject\":{\"details\":{\"hair\":\"blond\"}}}")]
    [InlineData("{\"subject\":[[\"blond\"]]}")]
    public void DeeperNesting_IsRejectedWhenSelected(string row)
    {
        File.WriteAllText(_path, row);
        Assert.Throws<QueryException>(() => Run("p:subject"));
    }

    [Fact]
    public void DefaultOutputIncludesLaterRecords_AndExplicitFirstDoesNotAdvance()
    {
        File.WriteAllText(_path, """
            {"subject":[null,{"hair":"blond","eyes":"blue"}]}
            {"subject":[{"hair":"","eyes":null},{"hair":"red","eyes":"green"}]}
            """);
        Assert.Empty(Run("p:subject[0]"));
        Assert.Equal(new[] { "blond, blue", "red, green" }, Run("p:subject"));
        Query query = QueryParser.Parse("p");
        ColumnSchema schema = _backend.GetSchema(_path);
        IReadOnlyList<string> columns = PromptColumnResolver.ResolveOutputColumns(query.PromptColumns, "subject", schema);
        SqlFilter filter = NestedQueryCompiler.Build(query, schema, [], columns);
        Assert.Equal(Run("p:subject"), _backend.GetPrompts(_path, columns, filter, 10, 0));
        Assert.Equal(2, _backend.CountRows(_path, filter));
        Assert.Equal(new[] { "hair: blond, eyes: blue", "hair: red, eyes: green" }, Run("p:subject[]|keys"));
        Assert.Equal(new[] { "blond, blue" }, Run("p[subject[i].hair=blond]:subject[i]"));
    }

    [Theory]
    [InlineData("\t")]
    [InlineData("\r\n")]
    [InlineData("\u0085")]
    [InlineData("\u00a0\u2003\u2028\u3000")]
    public void WhitespaceOnlyOutputs_AreExcludedBeforeCountingAndSampling(string whitespace)
    {
        File.WriteAllText(_path, System.Text.Json.JsonSerializer.Serialize(new
        {
            subject = new[] { new { hair = whitespace } },
        }) + "\n" + System.Text.Json.JsonSerializer.Serialize(new
        {
            subject = new[] { new { hair = whitespace + "Blond" + whitespace } },
        }));
        foreach (string query in new[] { "p:subject", "p:subject[]", "p:subject|keys" })
        {
            var (filter, columns) = Plan(query);
            Assert.Equal(1, _backend.CountRows(_path, filter));
            string expected = query.EndsWith("|keys") ? "hair: Blond" : "Blond";
            Assert.Equal(new[] { expected }, _backend.GetPrompts(_path, columns, filter, 10, 0));
            Assert.False(_backend.GetCandidateAt(_path, columns, filter, 0).Matches);
            Assert.Equal((expected, true), _backend.GetCandidateAt(_path, columns, filter, 1));
            Assert.Equal(expected, _backend.GetPromptAt(_path, columns, filter, 0));
        }
    }

    [Fact]
    public void LargestAcceptedIndex_IsMissingRatherThanOverflowing()
    {
        Assert.Empty(Run("p:subject[2147483647]"));
        Assert.Empty(Run("p[subject[2147483647].hair=blond]:style"));
        Assert.Equal(6, Run("p[subject[2147483647].hair!=blond]:style").Count);
    }

    [Fact]
    public void BindingNames_AreScopedToTheirArray()
    {
        File.WriteAllText(_path, """
            {"subject":[{"hair":"blond"}],"animal":[{"color":"black"}]}
            """);
        Assert.Equal("blond, black", Run("p[subject[i].hair=blond;animal[i].color=black]:subject[i],animal[i]").Single());
        Assert.Empty(Run("p[subject[i].hair=blond;subject[n].hair=blond]:subject[]"));
    }

    [Fact]
    public void ObjectTagColumns_SearchAllRecords_AndPreviewsShowValues()
    {
        var schema = _backend.GetSchema(_path);
        schema.TryGet("subject", out var subject);
        Query query = QueryParser.Parse("p[tags=red]:style");
        SqlFilter filter = NestedQueryCompiler.Build(query, schema, [subject], query.PromptColumns);
        Assert.Equal(new[] { "Photo", "Painting", "Backtrack" }, _backend.GetPrompts(_path, query.PromptColumns, filter, 10, 0));
        var preview = _backend.GetSampleRows(_path, 1);
        string cell = preview.Rows[0][preview.Columns.IndexOf("subject")];
        Assert.Contains("blond", cell);
        Assert.Contains("eyes", cell);
    }

    [Theory]
    [InlineData("p[subject[i].hair=blond;subject[n].hair=red]:subject[]", 2)]
    [InlineData("p[subject[].hair=blond,a-b]:subject", 0)]
    [InlineData("p[subject[].hair==blond,a-b]:subject", 1)]
    [InlineData("p[subject[].hair!=blond]:subject", 0)]
    [InlineData("p[subject[1].hair=dark-blond]:subject", 1)]
    [InlineData("p[subject[i]=blond]:subject[i]", 1)]
    public void CandidateFilters_OnlyApplySafeNecessaryConditions(string text, int anchors)
    {
        ColumnSchema original = _backend.GetSchema(_path);
        ColumnSchema indexed = new(original.Columns,
            [new("subject", "hair", "list", "__quarry_search_0"), new("subject", "eyes", "list", "__quarry_search_1")]);
        Query query = QueryParser.Parse(text);
        SqlFilter filter = NestedQueryCompiler.Build(query, indexed, [], query.PromptColumns);
        Assert.Equal(anchors, filter.CandidateParameters.Count);
        Assert.Equal(anchors == 0, string.IsNullOrEmpty(filter.CandidateWhereClause));
        // The JSON source cannot use helpers. Candidate-only parameters must not leak
        // into the exact scan or the physical-row sampling query.
        var expected = Plan(text);
        Assert.Equal(_backend.CountRows(_path, expected.Filter), _backend.CountRows(_path, filter));
        Assert.Equal(_backend.GetPrompts(_path, query.PromptColumns, expected.Filter, 10, 0),
            _backend.GetPrompts(_path, query.PromptColumns, filter, 10, 0));
        Assert.Equal(_backend.GetCandidateAt(_path, query.PromptColumns, expected.Filter, 0),
            _backend.GetCandidateAt(_path, query.PromptColumns, filter, 0));
    }

    [Fact]
    public void WholeRecordCandidate_RequiresEverySearchableField()
    {
        ColumnSchema original = _backend.GetSchema(_path);
        ColumnSchema partial = new(original.Columns, [new("subject", "hair", "list", "__quarry_search_0")]);
        Query query = QueryParser.Parse("p[subject[i]=blue]:subject[i]");
        SqlFilter filter = NestedQueryCompiler.Build(query, partial, [], query.PromptColumns);
        Assert.Empty(filter.CandidateWhereClause);
        Assert.Empty(filter.CandidateParameters);
    }

    public void Dispose()
    {
        _backend.Dispose();
        Directory.Delete(_root, true);
    }
}
