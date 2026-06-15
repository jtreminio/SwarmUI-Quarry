using Xunit;

namespace Quarry.Tests;

public class RandomSelectionTests
{
    private static Func<long> Sequence(params long[] values)
    {
        int i = 0;
        return () => values[i++ % values.Length];
    }

    [Fact]
    public void ZeroTotal_ReturnsEmpty()
    {
        Assert.Equal("", RandomSelection.Pick(0, 1, ", ", () => 0, i => "x"));
    }

    [Fact]
    public void ZeroPicks_ReturnsEmpty()
    {
        Assert.Equal("", RandomSelection.Pick(3, 0, ", ", () => 0, i => "x"));
    }

    [Fact]
    public void SinglePick_UsesIndexModTotal()
    {
        Assert.Equal("row1", RandomSelection.Pick(3, 1, ", ", () => 7, i => $"row{i}"));
    }

    [Fact]
    public void NegativeIndex_WrapsPositive()
    {
        Assert.Equal("row2", RandomSelection.Pick(3, 1, ", ", () => -1, i => $"row{i}"));
    }

    [Fact]
    public void MultiplePicks_DistinctWithoutReplacement()
    {
        Assert.Equal("row0,row1,row2", RandomSelection.Pick(3, 3, ",", Sequence(0, 1, 2), i => $"row{i}"));
    }

    [Fact]
    public void MultiplePicks_SkipsDuplicates()
    {
        Assert.Equal("row0,row1", RandomSelection.Pick(3, 2, ",", Sequence(0, 0, 1), i => $"row{i}"));
    }

    [Fact]
    public void PicksBeyondTotal_RefillsPool()
    {
        Assert.Equal("row0,row1,row0", RandomSelection.Pick(2, 3, ",", Sequence(0, 1, 0), i => $"row{i}"));
    }
}
