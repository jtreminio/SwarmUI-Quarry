using Xunit;

namespace Quarry.Tests;

public class WildcardQueryParserTests
{
    [Fact]
    public void BareName_NoClauses()
    {
        WildcardQuery q = WildcardQueryParser.Parse("prompts/1girl");
        Assert.Equal("prompts/1girl", q.Name);
        Assert.False(q.HasFilter);
        Assert.Empty(q.Clauses);
    }

    [Fact]
    public void BareName_TrimsWhitespace()
    {
        WildcardQuery q = WildcardQueryParser.Parse("  prompts/1girl  ");
        Assert.Equal("prompts/1girl", q.Name);
    }

    [Fact]
    public void AnyOperator_SingleClause()
    {
        WildcardQuery q = WildcardQueryParser.Parse("prompts/1girl[tags=brunette,punk]");
        Assert.Equal("prompts/1girl", q.Name);
        QueryClause c = Assert.Single(q.Clauses);
        Assert.Equal("tags", c.Column);
        Assert.Equal(MatchOp.Any, c.Op);
        Assert.Equal(new[] { "brunette", "punk" }, c.Values);
    }

    [Fact]
    public void AllOperator()
    {
        QueryClause c = Assert.Single(WildcardQueryParser.Parse("x[tags==a,b]").Clauses);
        Assert.Equal(MatchOp.All, c.Op);
        Assert.Equal("tags", c.Column);
        Assert.Equal(new[] { "a", "b" }, c.Values);
    }

    [Fact]
    public void NoneOperator()
    {
        QueryClause c = Assert.Single(WildcardQueryParser.Parse("x[tags!=nsfw]").Clauses);
        Assert.Equal(MatchOp.None, c.Op);
        Assert.Equal("tags", c.Column);
        Assert.Equal(new[] { "nsfw" }, c.Values);
    }

    [Fact]
    public void AllOperator_DoubleEquals()
    {
        QueryClause c = Assert.Single(WildcardQueryParser.Parse("p[Prompt==girl,red]").Clauses);
        Assert.Equal(MatchOp.All, c.Op);
        Assert.Equal("Prompt", c.Column);
        Assert.Equal(new[] { "girl", "red" }, c.Values);
    }

    [Fact]
    public void ValueContainingDoubleEquals_KeptInValue()
    {
        // The operator is the FIRST '='; since it's a single '=' (next char is a value char), this is 'any'
        // and the later '==' stays in the value.
        QueryClause c = Assert.Single(WildcardQueryParser.Parse("p[expr=a==b]").Clauses);
        Assert.Equal(MatchOp.Any, c.Op);
        Assert.Equal("expr", c.Column);
        Assert.Equal(new[] { "a==b" }, c.Values);
    }

    [Fact]
    public void MultipleClauses_AndedTogether()
    {
        WildcardQuery q = WildcardQueryParser.Parse("p[tags=brunette,punk;source=civitai]");
        Assert.Equal(2, q.Clauses.Count);
        Assert.Equal("tags", q.Clauses[0].Column);
        Assert.Equal(MatchOp.Any, q.Clauses[0].Op);
        Assert.Equal("source", q.Clauses[1].Column);
        Assert.Equal(new[] { "civitai" }, q.Clauses[1].Values);
    }

    [Fact]
    public void Whitespace_AroundTokens_Trimmed()
    {
        WildcardQuery q = WildcardQueryParser.Parse("p[ tags = a , b ; source = c ]");
        Assert.Equal("tags", q.Clauses[0].Column);
        Assert.Equal(new[] { "a", "b" }, q.Clauses[0].Values);
        Assert.Equal("source", q.Clauses[1].Column);
        Assert.Equal(new[] { "c" }, q.Clauses[1].Values);
    }

    [Fact]
    public void MultiWordValues_Preserved()
    {
        QueryClause c = Assert.Single(WildcardQueryParser.Parse("p[hair=long hair,short hair]").Clauses);
        Assert.Equal(new[] { "long hair", "short hair" }, c.Values);
    }

    [Fact]
    public void TrailingSemicolon_Ignored()
    {
        WildcardQuery q = WildcardQueryParser.Parse("p[tags=a;]");
        Assert.Single(q.Clauses);
    }

    [Fact]
    public void EmptyValuesBetweenCommas_Dropped()
    {
        QueryClause c = Assert.Single(WildcardQueryParser.Parse("p[tags=a,,b,]").Clauses);
        Assert.Equal(new[] { "a", "b" }, c.Values);
    }

    [Fact]
    public void ValueContainingEquals_KeptInValue()
    {
        QueryClause c = Assert.Single(WildcardQueryParser.Parse("p[expr=a=b]").Clauses);
        Assert.Equal("expr", c.Column);
        Assert.Equal(new[] { "a=b" }, c.Values);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void EmptyName_Throws(string input)
    {
        Assert.Throws<WildcardQueryParseException>(() => WildcardQueryParser.Parse(input));
    }

    [Fact]
    public void NullInput_Throws()
    {
        Assert.Throws<WildcardQueryParseException>(() => WildcardQueryParser.Parse(null));
    }

    [Fact]
    public void MissingClosingBracket_Throws()
    {
        Assert.Throws<WildcardQueryParseException>(() => WildcardQueryParser.Parse("p[tags=a"));
    }

    [Fact]
    public void EmptyBrackets_Throws()
    {
        Assert.Throws<WildcardQueryParseException>(() => WildcardQueryParser.Parse("p[]"));
    }

    [Fact]
    public void ClauseWithoutOperator_Throws()
    {
        Assert.Throws<WildcardQueryParseException>(() => WildcardQueryParser.Parse("p[tags]"));
    }

    [Fact]
    public void ClauseWithoutColumn_Throws()
    {
        Assert.Throws<WildcardQueryParseException>(() => WildcardQueryParser.Parse("p[=a]"));
    }

    [Fact]
    public void ClauseWithoutValues_Throws()
    {
        Assert.Throws<WildcardQueryParseException>(() => WildcardQueryParser.Parse("p[tags=]"));
    }

    [Fact]
    public void EmptyNameBeforeBracket_Throws()
    {
        Assert.Throws<WildcardQueryParseException>(() => WildcardQueryParser.Parse("[tags=a]"));
    }
}
