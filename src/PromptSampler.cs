using SwarmUI.Text2Image;

namespace Quarry;

/// <summary>One file matched by a reference: where to read its prompt from, the WHERE filter built for this
/// query, how many rows pass it (<paramref name="Count"/>), and the dataset's total row count
/// (<paramref name="Total"/>, used to gauge filter selectivity when sampling).</summary>
internal sealed record MatchedDataset(DatasetEntry Entry, string PromptColumn, SqlFilter Filter, long Count, long Total);

/// <summary>Reads a picked row's prompt from a matched dataset, choosing between a direct OFFSET seek and
/// rejection sampling based on filter selectivity.</summary>
internal static class PromptSampler
{
    // Datasets are blank-filtered at ingest, so a row total is the usable-pick total; this bounded probe past
    // a stray blank is only a backstop for a dataset added without that cleanup.
    private const int BlankProbeLimit = 8;

    // Random unfiltered seeks the rejection sampler tries before falling back to the OFFSET fetch. Doubles as
    // the selectivity gate: a filter matching fewer than ~1/this of the rows is scanned directly instead.
    private const int RejectionMaxAttempts = 48;

    /// <summary>Reads the picked row's prompt. A selective-enough filter samples a matching row by cheap random
    /// O(1) seeks; an empty or sparse filter (or sampling that finds only blanks) falls back to the
    /// deterministic OFFSET fetch. Returns "" only when the dataset is empty or every probed row is blank.</summary>
    public static string Fetch(MatchedDataset m, long localIndex, long globalIndex, T2IPromptHandling.PromptTagContext context)
    {
        if (m.Count <= 0)
        {
            return "";
        }
        if (!m.Filter.IsEmpty && TryRejectionSample(m, globalIndex, context) is string sampled)
        {
            return sampled;
        }
        return FetchByOffset(m, localIndex, context);
    }

    /// <summary>The deterministic fetch: the <paramref name="localIndex"/>-th row that passes the filter (or
    /// the localIndex-th row outright with no filter), probing a few rows forward past any stray blank. A pure
    /// function of localIndex, so it reproduces under a fixed seed (including the Index seed behavior).</summary>
    private static string FetchByOffset(MatchedDataset m, long localIndex, T2IPromptHandling.PromptTagContext context)
    {
        string value = "";
        for (int probe = 0; probe < BlankProbeLimit && m.Count > 0; probe++)
        {
            long row = (localIndex + probe) % m.Count;
            value = context.Parse(DatasetManager.Backend.GetPromptAt(m.Entry.Path, m.PromptColumn, m.Filter, row)).Trim();
            if (value.Length > 0)
            {
                break;
            }
        }
        return value;
    }

    /// <summary>Draws random rows from the dataset's full range, accepting the first that passes the filter and
    /// is non-blank. Returns null (fall back to OFFSET) when the filter is too sparse to sample efficiently or
    /// the bounded draws found no match. The candidate stream uses its OWN RNG seeded purely from
    /// <paramref name="globalIndex"/>, so picks reproduce under a fixed seed yet never perturb the shared
    /// wildcard RNG, and the pick is uniform over matching rows (matching the OFFSET fetch's distribution).</summary>
    private static string TryRejectionSample(MatchedDataset m, long globalIndex, T2IPromptHandling.PromptTagContext context)
    {
        // Selectivity gate: Total/Count is the expected draws per match; sample only when a hit is expected
        // within the attempt budget, else let the caller scan via OFFSET.
        if (m.Total <= 0 || m.Total > m.Count * (long)RejectionMaxAttempts)
        {
            return null;
        }
        Random random = new(RejectionSeed(globalIndex));
        for (int attempt = 0; attempt < RejectionMaxAttempts; attempt++)
        {
            long candidate = random.NextInt64(m.Total);
            (string raw, bool matches) = DatasetManager.Backend.GetCandidateAt(m.Entry.Path, m.PromptColumn, m.Filter, candidate);
            if (!matches)
            {
                continue;
            }
            string value = context.Parse(raw).Trim();
            if (value.Length > 0)
            {
                return value;
            }
            // A matching but blank row (rare — blanks excluded at ingest); keep sampling.
        }
        return null;
    }

    // Fibonacci-hash mix + xor-fold decorrelates adjacent indices so neighboring picks don't sample
    // near-identical sequences.
    private static int RejectionSeed(long globalIndex)
    {
        long mixed = unchecked(globalIndex * (long)0x9E3779B97F4A7C15UL);
        return unchecked((int)(mixed ^ (mixed >> 32)));
    }
}
