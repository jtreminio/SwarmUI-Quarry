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

    [Fact]
    public void MixedSource_SameSeed_IsDeterministic()
    {
        Func<long> a = RandomSelection.MixedSource(new Random(123));
        Func<long> b = RandomSelection.MixedSource(new Random(123));
        for (int i = 0; i < 10; i++)
        {
            Assert.Equal(a(), b());
        }
    }

    [Fact]
    public void MixedSource_ValuesNonNegative()
    {
        Func<long> source = RandomSelection.MixedSource(new Random(7));
        for (int i = 0; i < 1000; i++)
        {
            Assert.True(source() >= 0);
        }
    }

    [Fact]
    public void MixedSource_SequentialSeeds_AreUncorrelated()
    {
        // Unmixed first draws of .NET's seeded Random are nearly affine in the seed: across
        // sequential seeds (batch images) the deltas between adjacent first draws take only two
        // distinct values. The mixed draws must not inherit that lattice.
        HashSet<long> deltas = [];
        long prev = 0;
        for (int seed = 0; seed < 200; seed++)
        {
            long value = RandomSelection.MixedSource(new Random(seed))();
            if (seed > 0)
            {
                deltas.Add(value - prev);
            }
            prev = value;
        }
        Assert.True(deltas.Count >= 190);
    }

    [Fact]
    public void SequentialSource_StartsAtSeedAndIncrements()
    {
        Func<long> source = RandomSelection.SequentialSource(7);
        Assert.Equal(7, source());
        Assert.Equal(8, source());
        Assert.Equal(9, source());
    }

    [Fact]
    public void SequentialSource_MultiPick_YieldsDistinctRows()
    {
        Assert.Equal("row2,row3,row4", RandomSelection.Pick(5, 3, ",", RandomSelection.SequentialSource(7), i => $"row{i}"));
    }
}
