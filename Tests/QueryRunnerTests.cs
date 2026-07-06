using Xunit;

namespace Quarry.Tests;

public class QueryRunnerTests
{
    [Fact]
    public void NormalizeQueryInput_BareQuery_PassesThrough()
    {
        Assert.Equal("tags/**[tags=girl]", QueryRunner.NormalizeQueryInput("tags/**[tags=girl]"));
    }

    [Fact]
    public void NormalizeQueryInput_BareQuery_TrimsWhitespace()
    {
        Assert.Equal("tags/foo", QueryRunner.NormalizeQueryInput("  tags/foo  "));
    }

    [Fact]
    public void NormalizeQueryInput_FullTag_StripsWrapper()
    {
        Assert.Equal("tags/**[tags=girl; tags!=anthro]", QueryRunner.NormalizeQueryInput("<q:tags/**[tags=girl; tags!=anthro]>"));
    }

    [Theory]
    [InlineData("<q[2]:foo>")]
    [InlineData("<q[1-3]:foo>")]
    [InlineData("<q[12-34]:foo>")]
    public void NormalizeQueryInput_PredataForms_StripWrapper(string input)
    {
        Assert.Equal("foo", QueryRunner.NormalizeQueryInput(input));
    }

    [Fact]
    public void NormalizeQueryInput_IsCaseInsensitive()
    {
        Assert.Equal("Foo", QueryRunner.NormalizeQueryInput("<Q[2]:Foo>"));
    }

    [Fact]
    public void NormalizeQueryInput_FullTag_TrimsSurroundingAndInnerWhitespace()
    {
        Assert.Equal("tags/foo", QueryRunner.NormalizeQueryInput("  <q: tags/foo >  "));
    }

    [Fact]
    public void NormalizeQueryInput_MissingClosingBracket_TreatedAsBareText()
    {
        Assert.Equal("<q:tags/foo", QueryRunner.NormalizeQueryInput("<q:tags/foo"));
    }

    [Fact]
    public void NormalizeQueryInput_TrailingTextAfterTag_TreatedAsBareText()
    {
        Assert.Equal("<q:foo> bar", QueryRunner.NormalizeQueryInput("<q:foo> bar"));
    }

    [Fact]
    public void NormalizeQueryInput_MalformedPredata_TreatedAsBareText()
    {
        Assert.Equal("<q[x]:foo>", QueryRunner.NormalizeQueryInput("<q[x]:foo>"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void NormalizeQueryInput_NullOrBlank_ReturnsEmpty(string input)
    {
        Assert.Equal("", QueryRunner.NormalizeQueryInput(input));
    }

    [Fact]
    public void NormalizeQueryInput_EmptyTag_ReturnsEmpty()
    {
        Assert.Equal("", QueryRunner.NormalizeQueryInput("<q:>"));
    }

    [Theory]
    [InlineData(0, 25)]
    [InlineData(-5, 25)]
    [InlineData(1, 1)]
    [InlineData(25, 25)]
    [InlineData(499, 499)]
    [InlineData(500, 500)]
    [InlineData(501, 501)]
    [InlineData(10000, 10000)]
    [InlineData(int.MaxValue, int.MaxValue)]
    public void ClampMaxResults_DefaultsWhenUnsetButHonorsAnyPositiveCount(int input, int expected)
    {
        Assert.Equal(expected, QueryRunner.ClampMaxResults(input));
    }
}
