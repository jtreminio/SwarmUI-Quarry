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

    [Fact]
    public void RequestedColumn_WinsWhenItExists()
    {
        Assert.Equal("caption", PromptColumnResolver.Resolve("caption", "source", Schema("prompt", "source", "caption")));
    }

    [Fact]
    public void RequestedColumn_CaseInsensitive_ReturnsCanonical()
    {
        Assert.Equal("Caption", PromptColumnResolver.Resolve("caption", null, Schema("prompt", "Caption")));
    }

    [Fact]
    public void RequestedColumn_Missing_FallsBackToConfigured()
    {
        // The tag asked for a column this dataset does not have — fall back to its configured column.
        Assert.Equal("source", PromptColumnResolver.Resolve("nonexistent", "source", Schema("prompt", "source")));
    }

    [Fact]
    public void RequestedColumn_Missing_NoConfigured_FallsBackToPreferred()
    {
        Assert.Equal("prompt", PromptColumnResolver.Resolve("nonexistent", null, Schema("id", "prompt")));
    }

    [Fact]
    public void RequestedColumn_Missing_NoConfiguredNoPreferred_FallsBackToFirstColumn()
    {
        Assert.Equal("alpha", PromptColumnResolver.Resolve("nonexistent", null, Schema("alpha", "beta")));
    }

    [Fact]
    public void RequestedColumn_ResolvesPerFile_PresentInOneAbsentInAnother()
    {
        // The documented behavior: <q:FOO,BAZ:BAR> reads FOO.BAR (it has it) but BAZ's default (it does not).
        ColumnSchema foo = Schema("BAR", "prompt");
        ColumnSchema baz = Schema("id", "prompt");
        Assert.Equal("BAR", PromptColumnResolver.Resolve("BAR", null, foo));
        Assert.Equal("prompt", PromptColumnResolver.Resolve("BAR", null, baz));
    }
}
