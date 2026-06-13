using Xunit;

namespace Quarry.Tests;

public class PromptColumnResolverTests
{
    private static ColumnSchema Schema(params string[] names)
    {
        return new ColumnSchema(names.Select(n => new ColumnInfo(n, ColumnKind.Scalar)));
    }

    [Fact]
    public void UsesConfiguredColumn_WhenItExists()
    {
        Assert.Equal("source", PromptColumnResolver.Resolve("source", Schema("prompt", "source")));
    }

    [Fact]
    public void ConfiguredColumn_CaseInsensitive_ReturnsCanonical()
    {
        Assert.Equal("Prompt", PromptColumnResolver.Resolve("prompt", Schema("Prompt", "source")));
    }

    [Fact]
    public void IgnoresConfiguredWhenMissing_FallsBackToPreferred()
    {
        Assert.Equal("prompt", PromptColumnResolver.Resolve("nonexistent", Schema("id", "prompt")));
    }

    [Fact]
    public void AutoPicks_PreferredName()
    {
        Assert.Equal("caption", PromptColumnResolver.Resolve(null, Schema("id", "caption", "tags")));
    }

    [Fact]
    public void Preferred_IsCaseInsensitive()
    {
        Assert.Equal("PROMPT", PromptColumnResolver.Resolve(null, Schema("id", "PROMPT")));
    }

    [Fact]
    public void AutoPicks_FirstColumn_WhenNoPreferred()
    {
        Assert.Equal("alpha", PromptColumnResolver.Resolve(null, Schema("alpha", "beta")));
    }

    [Fact]
    public void EmptySchema_ReturnsNull()
    {
        Assert.Null(PromptColumnResolver.Resolve("x", Schema()));
    }
}
