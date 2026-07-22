using SwarmUI.Text2Image;

namespace Quarry;

internal sealed record MatchedDataset(DatasetEntry Entry, string PromptColumn, SqlFilter Filter, long Count, long Total, IReadOnlyList<string>? PromptColumns = null);

internal static class PromptSampler
{
    private const int BlankProbeLimit = 8;
    private const int RejectionMaxAttempts = 48;

    public static string Fetch(MatchedDataset m, long localIndex, long draw, T2IPromptHandling.PromptTagContext context)
    {
        if (m.Count <= 0)
        {
            return "";
        }
        if (!m.Filter.IsEmpty && TryRejectionSample(m, draw, context) is string sampled)
        {
            return sampled;
        }
        return FetchByOffset(m, localIndex, context);
    }

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

    // Seeding from the full raw draw (not the derived row index) matters: the row index only takes
    // m.Count distinct values, which would freeze the sampler into a fixed index->row map where some
    // matching rows are never reachable and others are picked several times as often.
    private static string TryRejectionSample(MatchedDataset m, long draw, T2IPromptHandling.PromptTagContext context)
    {
        if (m.Total <= 0 || m.Total > m.Count * (long)RejectionMaxAttempts)
        {
            return null;
        }
        Random random = new(RejectionSeed(draw));
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
        }
        return null;
    }

    private static int RejectionSeed(long draw)
    {
        long mixed = unchecked(draw * (long)0x9E3779B97F4A7C15UL);
        return unchecked((int)(mixed ^ (mixed >> 32)));
    }
}
