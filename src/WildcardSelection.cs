namespace Quarry;

/// <summary>The seeded, reproducible row-selection shared by the wildcard handler, mirroring SwarmUI
/// core's wildcard picking: draw <c>picks</c> indices in <c>[0, total)</c> from the supplied index
/// source (without replacement until the pool is exhausted, then refilled), fetch each, and join with
/// the separator. Pure — no DuckDB, no SwarmUI — so the algorithm is unit-testable on its own.</summary>
public static class WildcardSelection
{
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
                used.Clear(); // pool exhausted — allow repeats again (matches core for picks > total)
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
