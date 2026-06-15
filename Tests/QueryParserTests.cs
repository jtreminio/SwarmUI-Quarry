using Xunit;

namespace Quarry.Tests;

public class QueryParserTests
{
    [Fact]
    public void BareName_NoClauses()
    {
        Query q = QueryParser.Parse("prompts/1girl");
        Assert.Equal("prompts/1girl", q.Name);
        Assert.False(q.HasFilter);
        Assert.Empty(q.Clauses);
    }

    [Fact]
    public void BareName_TrimsWhitespace()
    {
        Query q = QueryParser.Parse("  prompts/1girl  ");
        Assert.Equal("prompts/1girl", q.Name);
    }

    [Fact]
    public void BareName_HasNoPromptColumn()
    {
        Assert.Null(QueryParser.Parse("prompts/1girl").PromptColumn);
    }

    [Fact]
    public void PromptColumn_OnBareName()
    {
        Query q = QueryParser.Parse("FOO:BAR");
        Assert.Equal("FOO", q.Name);
        Assert.False(q.HasFilter);
        Assert.Equal("BAR", q.PromptColumn);
    }

    [Fact]
    public void PromptColumn_WithFilter()
    {
        Query q = QueryParser.Parse("FOO[tags=girl]:BAR");
        Assert.Equal("FOO", q.Name);
        Assert.Equal("BAR", q.PromptColumn);
        QueryClause c = Assert.Single(q.Clauses);
        Assert.Equal("tags", c.Column);
        Assert.Equal(MatchOp.Any, c.Op);
        Assert.Equal(new[] { "girl" }, c.Values);
    }

    [Fact]
    public void PromptColumn_WithMultipleNames()
    {
        Query q = QueryParser.Parse("FOO,BAZ:BAR");
        Assert.Equal("FOO,BAZ", q.Name);
        Assert.False(q.HasFilter);
        Assert.Equal("BAR", q.PromptColumn);
    }

    [Fact]
    public void PromptColumn_WithMultipleNamesAndFilter()
    {
        Query q = QueryParser.Parse("FOO,BAZ[tags=girl]:BAR");
        Assert.Equal("FOO,BAZ", q.Name);
        Assert.Equal("BAR", q.PromptColumn);
        QueryClause c = Assert.Single(q.Clauses);
        Assert.Equal("tags", c.Column);
        Assert.Equal(new[] { "girl" }, c.Values);
    }

    [Fact]
    public void PromptColumn_TrimsWhitespace()
    {
        Query q = QueryParser.Parse("  FOO  :  BAR  ");
        Assert.Equal("FOO", q.Name);
        Assert.Equal("BAR", q.PromptColumn);
    }

    [Fact]
    public void ColonInsideFilterValue_NotTreatedAsPromptColumn()
    {
        Query q = QueryParser.Parse("FOO[url=http://x]");
        Assert.Equal("FOO", q.Name);
        Assert.Null(q.PromptColumn);
        QueryClause c = Assert.Single(q.Clauses);
        Assert.Equal("url", c.Column);
        Assert.Equal(new[] { "http://x" }, c.Values);
    }

    [Fact]
    public void ColonInsideFilterValue_WithTrailingPromptColumn()
    {
        Query q = QueryParser.Parse("FOO[url=http://x]:BAR");
        Assert.Equal("FOO", q.Name);
        Assert.Equal("BAR", q.PromptColumn);
        QueryClause c = Assert.Single(q.Clauses);
        Assert.Equal("url", c.Column);
        Assert.Equal(new[] { "http://x" }, c.Values);
    }

    [Fact]
    public void EmptyPromptColumn_Throws()
    {
        Assert.Throws<QueryParseException>(() => QueryParser.Parse("FOO:"));
    }

    [Fact]
    public void EmptyPromptColumn_AfterFilter_Throws()
    {
        Assert.Throws<QueryParseException>(() => QueryParser.Parse("FOO[tags=girl]:"));
    }

    [Fact]
    public void AnyOperator_SingleClause()
    {
        Query q = QueryParser.Parse("prompts/1girl[tags=brunette,punk]");
        Assert.Equal("prompts/1girl", q.Name);
        QueryClause c = Assert.Single(q.Clauses);
        Assert.Equal("tags", c.Column);
        Assert.Equal(MatchOp.Any, c.Op);
        Assert.Equal(new[] { "brunette", "punk" }, c.Values);
    }

    [Fact]
    public void AllOperator()
    {
        QueryClause c = Assert.Single(QueryParser.Parse("x[tags==a,b]").Clauses);
        Assert.Equal(MatchOp.All, c.Op);
        Assert.Equal("tags", c.Column);
        Assert.Equal(new[] { "a", "b" }, c.Values);
    }

    [Fact]
    public void NoneOperator()
    {
        QueryClause c = Assert.Single(QueryParser.Parse("x[tags!=nsfw]").Clauses);
        Assert.Equal(MatchOp.None, c.Op);
        Assert.Equal("tags", c.Column);
        Assert.Equal(new[] { "nsfw" }, c.Values);
    }

    [Fact]
    public void AllOperator_DoubleEquals()
    {
        QueryClause c = Assert.Single(QueryParser.Parse("p[Prompt==girl,red]").Clauses);
        Assert.Equal(MatchOp.All, c.Op);
        Assert.Equal("Prompt", c.Column);
        Assert.Equal(new[] { "girl", "red" }, c.Values);
    }

    [Fact]
    public void ValueContainingDoubleEquals_KeptInValue()
    {
        // The operator is the FIRST '='; since it's a single '=' (next char is a value char), this is 'any'
        // and the later '==' stays in the value.
        QueryClause c = Assert.Single(QueryParser.Parse("p[expr=a==b]").Clauses);
        Assert.Equal(MatchOp.Any, c.Op);
        Assert.Equal("expr", c.Column);
        Assert.Equal(new[] { "a==b" }, c.Values);
    }

    [Fact]
    public void MultipleClauses_AndedTogether()
    {
        Query q = QueryParser.Parse("p[tags=brunette,punk;source=civitai]");
        Assert.Equal(2, q.Clauses.Count);
        Assert.Equal("tags", q.Clauses[0].Column);
        Assert.Equal(MatchOp.Any, q.Clauses[0].Op);
        Assert.Equal("source", q.Clauses[1].Column);
        Assert.Equal(new[] { "civitai" }, q.Clauses[1].Values);
    }

    [Fact]
    public void Whitespace_AroundTokens_Trimmed()
    {
        Query q = QueryParser.Parse("p[ tags = a , b ; source = c ]");
        Assert.Equal("tags", q.Clauses[0].Column);
        Assert.Equal(new[] { "a", "b" }, q.Clauses[0].Values);
        Assert.Equal("source", q.Clauses[1].Column);
        Assert.Equal(new[] { "c" }, q.Clauses[1].Values);
    }

    [Fact]
    public void MultiWordValues_Preserved()
    {
        QueryClause c = Assert.Single(QueryParser.Parse("p[hair=long hair,short hair]").Clauses);
        Assert.Equal(new[] { "long hair", "short hair" }, c.Values);
    }

    [Fact]
    public void TrailingSemicolon_Ignored()
    {
        Query q = QueryParser.Parse("p[tags=a;]");
        Assert.Single(q.Clauses);
    }

    [Fact]
    public void EmptyValuesBetweenCommas_Dropped()
    {
        QueryClause c = Assert.Single(QueryParser.Parse("p[tags=a,,b,]").Clauses);
        Assert.Equal(new[] { "a", "b" }, c.Values);
    }

    [Fact]
    public void ValueContainingEquals_KeptInValue()
    {
        QueryClause c = Assert.Single(QueryParser.Parse("p[expr=a=b]").Clauses);
        Assert.Equal("expr", c.Column);
        Assert.Equal(new[] { "a=b" }, c.Values);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void EmptyName_Throws(string input)
    {
        Assert.Throws<QueryParseException>(() => QueryParser.Parse(input));
    }

    [Fact]
    public void NullInput_Throws()
    {
        Assert.Throws<QueryParseException>(() => QueryParser.Parse(null));
    }

    [Fact]
    public void MissingClosingBracket_Throws()
    {
        Assert.Throws<QueryParseException>(() => QueryParser.Parse("p[tags=a"));
    }

    [Fact]
    public void EmptyBrackets_Throws()
    {
        Assert.Throws<QueryParseException>(() => QueryParser.Parse("p[]"));
    }

    [Fact]
    public void ClauseWithoutOperator_Throws()
    {
        Assert.Throws<QueryParseException>(() => QueryParser.Parse("p[tags]"));
    }

    [Fact]
    public void ClauseWithoutColumn_Throws()
    {
        Assert.Throws<QueryParseException>(() => QueryParser.Parse("p[=a]"));
    }

    [Fact]
    public void ClauseWithoutValues_Throws()
    {
        Assert.Throws<QueryParseException>(() => QueryParser.Parse("p[tags=]"));
    }

    [Fact]
    public void EmptyNameBeforeBracket_Throws()
    {
        Assert.Throws<QueryParseException>(() => QueryParser.Parse("[tags=a]"));
    }
}
