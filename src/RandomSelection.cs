namespace Quarry;

public static class RandomSelection
{
    /// <summary>Draw source for "Random" wildcard-seed behavior. Two raw draws are folded through a
    /// splitmix64 finalizer: .NET's seeded <see cref="Random"/> (legacy Knuth) yields a first draw that is
    /// nearly affine in the seed, so the consecutive per-image seeds of a multi-image request would
    /// otherwise land on a rigid lattice of rows. Mixing keeps picks reproducible for a fixed wildcard
    /// seed while making nearby seeds produce uncorrelated indices.</summary>
    public static Func<long> MixedSource(Random random) => () =>
    {
        ulong high = (uint)random.Next();
        ulong low = (uint)random.Next();
        return Mix((high << 31) | low);
    };

    /// <summary>Draw source for "Index" wildcard-seed behavior: seed, seed+1, seed+2, ... so the first
    /// pick stays at the seed's row and multi-pick tags step to distinct rows instead of repeating one.</summary>
    public static Func<long> SequentialSource(long seed)
    {
        long next = seed;
        return () => next++;
    }

    private static long Mix(ulong value)
    {
        unchecked
        {
            ulong z = value + 0x9E3779B97F4A7C15UL;
            z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL;
            z = (z ^ (z >> 27)) * 0x94D049BB133111EBUL;
            return (long)((z ^ (z >> 31)) >> 1);
        }
    }

    public static string Pick(long total, int picks, string separator, Func<long> nextIndex, Func<long, string> fetch)
    {
        if (total <= 0 || picks <= 0)
        {
            return "";
        }
        List<string> parts = new(picks);
        HashSet<long> used = [];
        for (int i = 0; i < picks; i++)
        {
            long index = Draw(total, used, nextIndex);
            used.Add(index);
            parts.Add(fetch(index));
            if (used.Count >= total)
            {
                used.Clear();
            }
        }
        return string.Join(separator, parts);
    }

    private static long Draw(long total, HashSet<long> used, Func<long> nextIndex)
    {
        long index = Mod(nextIndex(), total);
        for (int attempt = 0; attempt < 64 && used.Contains(index); attempt++)
        {
            index = Mod(nextIndex(), total);
        }
        return index;
    }

    private static long Mod(long value, long total)
    {
        long mod = value % total;
        return mod < 0 ? mod + total : mod;
    }
}
