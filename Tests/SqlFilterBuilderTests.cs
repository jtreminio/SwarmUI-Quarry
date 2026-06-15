using Xunit;

namespace Quarry.Tests;

public class SqlFilterBuilderTests
{
    private static ColumnSchema Schema(params (string name, ColumnKind kind)[] cols)
    {
        return new ColumnSchema(cols.Select(c => new ColumnInfo(c.name, c.kind)));
    }

    private static SqlFilter Build(string data, params (string, ColumnKind)[] cols)
    {
        return SqlFilterBuilder.Build(QueryParser.Parse(data), Schema(cols));
    }

    private static SqlFilter BuildWithTags(string data, string[] tagColumns, params (string, ColumnKind)[] cols)
    {
        ColumnSchema schema = Schema(cols);
        List<ColumnInfo> tags = [.. tagColumns.Select(t => { schema.TryGet(t, out ColumnInfo c); return c; })];
        return SqlFilterBuilder.Build(QueryParser.Parse(data), schema, tags);
    }

    [Fact]
    public void NoFilter_ReturnsEmpty()
    {
        SqlFilter f = Build("prompts/1girl");
        Assert.True(f.IsEmpty);
        Assert.Empty(f.Parameters);
        Assert.Equal("", f.WhereClause);
    }

    // --- Scalar/text columns: contains (case-insensitive substring) ---------------------------------

    [Fact]
    public void ScalarAny_BuildsContainsOr()
    {
        SqlFilter f = Build("p[source=civitai,local]", ("source", ColumnKind.Scalar));
        Assert.Equal(
            "(contains(lower(\"source\"), lower($p0)) OR contains(lower(\"source\"), lower($p1)))",
            f.WhereClause);
        Assert.Equal(new[] { "p0", "p1" }, f.Parameters.Select(p => p.Name));
        Assert.Equal(new[] { "civitai", "local" }, f.Parameters.Select(p => p.Value));
    }

    [Fact]
    public void ScalarAll_BuildsContainsAnd()
    {
        SqlFilter f = Build("p[Prompt==girl,red]", ("Prompt", ColumnKind.Scalar));
        Assert.Equal(
            "(contains(lower(\"Prompt\"), lower($p0)) AND contains(lower(\"Prompt\"), lower($p1)))",
            f.WhereClause);
    }

    [Fact]
    public void ScalarNone_BuildsNotContains()
    {
        SqlFilter f = Build("p[Prompt!=nsfw]", ("Prompt", ColumnKind.Scalar));
        Assert.Equal("NOT (contains(lower(\"Prompt\"), lower($p0)))", f.WhereClause);
        Assert.Equal("nsfw", Assert.Single(f.Parameters).Value);
    }

    [Fact]
    public void ScalarAny_SingleValue()
    {
        SqlFilter f = Build("p[Prompt=girl]", ("Prompt", ColumnKind.Scalar));
        Assert.Equal("(contains(lower(\"Prompt\"), lower($p0)))", f.WhereClause);
    }

    // --- List columns: case-insensitive substring against each element ------------------------------

    [Fact]
    public void ListAny_BuildsPerElementContainsOr()
    {
        SqlFilter f = Build("p[tags=a,b]", ("tags", ColumnKind.List));
        Assert.Equal(
            "(len(list_filter(\"tags\", x -> contains(lower(x), lower($p0)))) > 0 OR len(list_filter(\"tags\", x -> contains(lower(x), lower($p1)))) > 0)",
            f.WhereClause);
    }

    [Fact]
    public void ListAll_BuildsPerElementContainsAnd()
    {
        SqlFilter f = Build("p[tags==a,b]", ("tags", ColumnKind.List));
        Assert.Equal(
            "(len(list_filter(\"tags\", x -> contains(lower(x), lower($p0)))) > 0 AND len(list_filter(\"tags\", x -> contains(lower(x), lower($p1)))) > 0)",
            f.WhereClause);
    }

    [Fact]
    public void ListNone_BuildsNotPerElementContains()
    {
        SqlFilter f = Build("p[tags!=nsfw]", ("tags", ColumnKind.List));
        Assert.Equal(
            "NOT (len(list_filter(\"tags\", x -> contains(lower(x), lower($p0)))) > 0)",
            f.WhereClause);
    }

    // --- Mixed / general ----------------------------------------------------------------------------

    [Fact]
    public void MultipleClauses_JoinedWithAnd_ParamsSequential()
    {
        SqlFilter f = Build(
            "p[tags=a,b;source=civitai]",
            ("tags", ColumnKind.List),
            ("source", ColumnKind.Scalar));
        Assert.Equal(
            "(len(list_filter(\"tags\", x -> contains(lower(x), lower($p0)))) > 0 OR len(list_filter(\"tags\", x -> contains(lower(x), lower($p1)))) > 0) AND (contains(lower(\"source\"), lower($p2)))",
            f.WhereClause);
        Assert.Equal(new[] { "a", "b", "civitai" }, f.Parameters.Select(p => p.Value));
    }

    // --- tags keyword: configured tag columns searched as one merged column -------------------------

    [Fact]
    public void TagsKeyword_SingleScalarColumn_BuildsContains()
    {
        SqlFilter f = BuildWithTags("p[tags=1girl]", ["bar"], ("foo", ColumnKind.Scalar), ("bar", ColumnKind.Scalar));
        Assert.Equal("(contains(lower(\"bar\"), lower($p0)))", f.WhereClause);
        Assert.Equal("1girl", Assert.Single(f.Parameters).Value);
    }

    [Fact]
    public void TagsKeyword_TwoScalarColumns_Any_OrsAcrossColumns()
    {
        SqlFilter f = BuildWithTags("p[tags=1girl]", ["bar", "baz"], ("bar", ColumnKind.Scalar), ("baz", ColumnKind.Scalar));
        Assert.Equal(
            "((contains(lower(\"bar\"), lower($p0)) OR contains(lower(\"baz\"), lower($p0))))",
            f.WhereClause);
    }

    [Fact]
    public void TagsKeyword_TwoColumns_All_IsCumulativePerValue()
    {
        SqlFilter f = BuildWithTags("p[tags==1girl,solo]", ["bar", "baz"], ("bar", ColumnKind.Scalar), ("baz", ColumnKind.Scalar));
        Assert.Equal(
            "((contains(lower(\"bar\"), lower($p0)) OR contains(lower(\"baz\"), lower($p0))) AND (contains(lower(\"bar\"), lower($p1)) OR contains(lower(\"baz\"), lower($p1))))",
            f.WhereClause);
        Assert.Equal(new[] { "1girl", "solo" }, f.Parameters.Select(p => p.Value));
    }

    [Fact]
    public void TagsKeyword_None_NegatesTheMergedMatch()
    {
        SqlFilter f = BuildWithTags("p[tags!=nsfw]", ["bar", "baz"], ("bar", ColumnKind.Scalar), ("baz", ColumnKind.Scalar));
        Assert.Equal(
            "NOT ((contains(lower(\"bar\"), lower($p0)) OR contains(lower(\"baz\"), lower($p0))))",
            f.WhereClause);
    }

    [Fact]
    public void TagsKeyword_MixedScalarAndListColumns()
    {
        SqlFilter f = BuildWithTags("p[tags=1girl]", ["bar", "baz"], ("bar", ColumnKind.Scalar), ("baz", ColumnKind.List));
        Assert.Equal(
            "((contains(lower(\"bar\"), lower($p0)) OR len(list_filter(\"baz\", x -> contains(lower(x), lower($p0)))) > 0))",
            f.WhereClause);
    }

    [Fact]
    public void TagsKeyword_NoConfiguredColumns_FallsBackToLiteralColumn()
    {
        // With no tag columns configured, `tags` behaves as a literal column name (today's behavior).
        SqlFilter f = BuildWithTags("p[tags=a,b]", [], ("tags", ColumnKind.List));
        Assert.Equal(
            "(len(list_filter(\"tags\", x -> contains(lower(x), lower($p0)))) > 0 OR len(list_filter(\"tags\", x -> contains(lower(x), lower($p1)))) > 0)",
            f.WhereClause);
    }

    [Fact]
    public void UnknownColumn_Throws()
    {
        Assert.Throws<QueryException>(() => Build("p[missing=a]", ("tags", ColumnKind.List)));
    }

    [Fact]
    public void ColumnLookup_IsCaseInsensitive_QuotesCanonicalName()
    {
        SqlFilter f = Build("p[TAGS=a]", ("tags", ColumnKind.List));
        Assert.Equal("(len(list_filter(\"tags\", x -> contains(lower(x), lower($p0)))) > 0)", f.WhereClause);
    }

    [Fact]
    public void IdentifierWithEmbeddedQuote_IsEscaped()
    {
        SqlFilter f = Build("p[wei\"rd=a]", ("wei\"rd", ColumnKind.Scalar));
        Assert.Equal("(contains(lower(\"wei\"\"rd\"), lower($p0)))", f.WhereClause);
    }

    [Fact]
    public void ValuesAreBound_NotInterpolated()
    {
        // A value carrying SQL metacharacters must land verbatim in a bound parameter, never the SQL text.
        SqlFilter f = Build("p[source=x' OR '1'='1]", ("source", ColumnKind.Scalar));
        Assert.Equal("(contains(lower(\"source\"), lower($p0)))", f.WhereClause);
        Assert.Equal("x' OR '1'='1", Assert.Single(f.Parameters).Value);
    }
}
