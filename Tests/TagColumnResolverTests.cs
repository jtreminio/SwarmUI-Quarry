using Xunit;

namespace Quarry.Tests;

public class TagColumnResolverTests
{
    private static ColumnSchema Schema(params (string name, ColumnKind kind)[] cols)
    {
        return new ColumnSchema(cols.Select(c => new ColumnInfo(c.name, c.kind)));
    }

    [Fact]
    public void KeepsConfiguredColumns_InOrder_CanonicalCasing()
    {
        List<ColumnInfo> result = TagColumnResolver.Resolve(
            ["BAR", "baz"],
            Schema(("foo", ColumnKind.Scalar), ("Bar", ColumnKind.Scalar), ("baz", ColumnKind.List)));
        Assert.Equal(new[] { "Bar", "baz" }, result.Select(c => c.Name));
        Assert.Equal(new[] { ColumnKind.Scalar, ColumnKind.List }, result.Select(c => c.Kind));
    }

    [Fact]
    public void DropsColumnsNotInSchema()
    {
        List<ColumnInfo> result = TagColumnResolver.Resolve(
            ["bar", "missing"],
            Schema(("bar", ColumnKind.Scalar)));
        Assert.Equal(new[] { "bar" }, result.Select(c => c.Name));
    }

    [Fact]
    public void DeduplicatesByCanonicalName()
    {
        List<ColumnInfo> result = TagColumnResolver.Resolve(
            ["bar", "BAR", "bar"],
            Schema(("bar", ColumnKind.Scalar)));
        Assert.Equal(new[] { "bar" }, result.Select(c => c.Name));
    }

    [Fact]
    public void IgnoresNullAndBlankNames()
    {
        List<ColumnInfo> result = TagColumnResolver.Resolve(
            [null, "", "  ", "bar"],
            Schema(("bar", ColumnKind.Scalar)));
        Assert.Equal(new[] { "bar" }, result.Select(c => c.Name));
    }

    [Fact]
    public void NullConfigured_ReturnsEmpty()
    {
        Assert.Empty(TagColumnResolver.Resolve(null, Schema(("bar", ColumnKind.Scalar))));
    }

    [Fact]
    public void NoneConfigured_ReturnsEmpty()
    {
        Assert.Empty(TagColumnResolver.Resolve([], Schema(("bar", ColumnKind.Scalar))));
    }

    [Fact]
    public void NoneConfigured_FallsBackToPromptColumn()
    {
        List<ColumnInfo> result = TagColumnResolver.Resolve([], Schema(("prompt", ColumnKind.Scalar)), "prompt");
        Assert.Equal(new[] { "prompt" }, result.Select(c => c.Name));
    }

    [Fact]
    public void ConfiguredColumns_TakePrecedenceOverFallback()
    {
        List<ColumnInfo> result = TagColumnResolver.Resolve(
            ["bar"],
            Schema(("prompt", ColumnKind.Scalar), ("bar", ColumnKind.Scalar)),
            "prompt");
        Assert.Equal(new[] { "bar" }, result.Select(c => c.Name));
    }

    [Fact]
    public void Fallback_UsedWhenConfiguredNamesAllMissing()
    {
        List<ColumnInfo> result = TagColumnResolver.Resolve(
            ["nonexistent"],
            Schema(("prompt", ColumnKind.Scalar)),
            "prompt");
        Assert.Equal(new[] { "prompt" }, result.Select(c => c.Name));
    }

    [Fact]
    public void Fallback_IgnoredWhenItDoesNotExist()
    {
        Assert.Empty(TagColumnResolver.Resolve([], Schema(("bar", ColumnKind.Scalar)), "missing"));
    }
}
