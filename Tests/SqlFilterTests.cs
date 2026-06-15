using Xunit;

namespace Quarry.Tests;

/// <summary>Covers <see cref="SqlFilter.CacheKey"/>, which keys the filtered row-count cache. It must be equal
/// for equal filters and distinct for any meaningful difference (column, operator, value, or order) — and it
/// must never let value content be confused for structure, or one filter could serve another's row count.</summary>
public class SqlFilterTests
{
    private static ColumnSchema Schema(params (string name, ColumnKind kind)[] cols)
        => new(cols.Select(c => new ColumnInfo(c.name, c.kind)));

    private static SqlFilter Build(string data, params (string, ColumnKind)[] cols)
        => SqlFilterBuilder.Build(QueryParser.Parse(data), Schema(cols));

    [Fact]
    public void EmptyFilter_HasEmptyCacheKey()
    {
        Assert.Equal("", SqlFilter.None.CacheKey);
        Assert.Equal("", Build("p").CacheKey); // a bare name with no [filter]
    }

    [Fact]
    public void SameFilter_SameCacheKey()
    {
        string a = Build("p[Prompt=girl]", ("Prompt", ColumnKind.Scalar)).CacheKey;
        string b = Build("p[Prompt=girl]", ("Prompt", ColumnKind.Scalar)).CacheKey;
        Assert.Equal(a, b);
        Assert.NotEqual("", a);
    }

    [Fact]
    public void DifferentValue_DifferentCacheKey()
    {
        string girl = Build("p[Prompt=girl]", ("Prompt", ColumnKind.Scalar)).CacheKey;
        string boy = Build("p[Prompt=boy]", ("Prompt", ColumnKind.Scalar)).CacheKey;
        Assert.NotEqual(girl, boy);
    }

    [Fact]
    public void DifferentColumn_DifferentCacheKey()
    {
        string a = Build("p[a=girl]", ("a", ColumnKind.Scalar), ("b", ColumnKind.Scalar)).CacheKey;
        string b = Build("p[b=girl]", ("a", ColumnKind.Scalar), ("b", ColumnKind.Scalar)).CacheKey;
        Assert.NotEqual(a, b);
    }

    [Fact]
    public void DifferentOperator_DifferentCacheKey()
    {
        string any = Build("p[Prompt=girl,boy]", ("Prompt", ColumnKind.Scalar)).CacheKey;
        string all = Build("p[Prompt==girl,boy]", ("Prompt", ColumnKind.Scalar)).CacheKey;
        Assert.NotEqual(any, all);
    }

    [Fact]
    public void ValueOrder_AffectsCacheKey()
    {
        string ab = Build("p[Prompt=a,b]", ("Prompt", ColumnKind.Scalar)).CacheKey;
        string ba = Build("p[Prompt=b,a]", ("Prompt", ColumnKind.Scalar)).CacheKey;
        Assert.NotEqual(ab, ba);
    }

    [Fact]
    public void LengthPrefixing_PreventsDelimiterCollision()
    {
        // Same WHERE text, but one filter binds two values [a, b] and the other binds the single value "a|b".
        // A naive "join values with |" key would render both as "...|a|b" and collide; length-prefixing each
        // part keeps them distinct, so the two-value query can't reuse the one-value query's cached count.
        SqlFilter twoValues = new("x", [new QueryParameter("p0", "a"), new QueryParameter("p1", "b")]);
        SqlFilter oneValue = new("x", [new QueryParameter("p0", "a|b")]);
        Assert.NotEqual(twoValues.CacheKey, oneValue.CacheKey);
    }
}
