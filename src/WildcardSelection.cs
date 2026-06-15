namespace Quarry;

// Seeded row picking mirroring SwarmUI core: draw `picks` indices in [0, total) without replacement
// until the pool is exhausted (then refill), fetch each, and join with the separator.
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
