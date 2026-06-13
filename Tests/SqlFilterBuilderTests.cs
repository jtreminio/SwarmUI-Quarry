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
        return SqlFilterBuilder.Build(WildcardQueryParser.Parse(data), Schema(cols));
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

    // --- List columns: element membership -----------------------------------------------------------

    [Fact]
    public void ListAny_BuildsHasAny()
    {
        SqlFilter f = Build("p[tags=a,b]", ("tags", ColumnKind.List));
        Assert.Equal("list_has_any(\"tags\", list_value($p0, $p1))", f.WhereClause);
    }

    [Fact]
    public void ListAll_BuildsHasAll()
    {
        SqlFilter f = Build("p[tags==a,b]", ("tags", ColumnKind.List));
        Assert.Equal("list_has_all(\"tags\", list_value($p0, $p1))", f.WhereClause);
    }

    [Fact]
    public void ListNone_BuildsNotHasAny()
    {
        SqlFilter f = Build("p[tags!=nsfw]", ("tags", ColumnKind.List));
        Assert.Equal("NOT list_has_any(\"tags\", list_value($p0))", f.WhereClause);
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
            "list_has_any(\"tags\", list_value($p0, $p1)) AND (contains(lower(\"source\"), lower($p2)))",
            f.WhereClause);
        Assert.Equal(new[] { "a", "b", "civitai" }, f.Parameters.Select(p => p.Value));
    }

    [Fact]
    public void UnknownColumn_Throws()
    {
        Assert.Throws<WildcardQueryException>(() => Build("p[missing=a]", ("tags", ColumnKind.List)));
    }

    [Fact]
    public void ColumnLookup_IsCaseInsensitive_QuotesCanonicalName()
    {
        SqlFilter f = Build("p[TAGS=a]", ("tags", ColumnKind.List));
        Assert.Equal("list_has_any(\"tags\", list_value($p0))", f.WhereClause);
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
