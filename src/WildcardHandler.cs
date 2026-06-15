using System.Text.RegularExpressions;
using FreneticUtilities.FreneticExtensions;
using SwarmUI.Text2Image;
using SwarmUI.Utils;

namespace Quarry;

/// <summary>Registers SwarmUI's <c>q</c> prompt-tag (<c>&lt;q:NAME[query]&gt;</c>) and serves it from our
/// datasets via DuckDB. The <c>q</c> prefix is Quarry's own — it does not piggyback on, capture, or chain to
/// core's <c>wc</c>/<c>wildcard</c> handlers. A <c>q</c> reference that doesn't match a dataset is dropped
/// (with a warning when the extension is active) rather than delegated anywhere.</summary>
public static class WildcardHandler
{
    /// <summary>The prompt-tag prefix this extension owns: <c>&lt;q:...&gt;</c>.</summary>
    public const string TagPrefix = "q";

    /// <summary>How many rows to probe forward from a picked index when that row's prompt is blank. Datasets
    /// are blank-filtered at ingest (scripts/to_lancedb.py), so this only matters for a dataset added without
    /// that cleanup; a small bound skips the occasional stray empty row without letting a pathological
    /// all-blank file loop.</summary>
    private const int BlankProbeLimit = 8;

    public static void Initialize()
    {
        T2IPromptHandling.PromptTagProcessors[TagPrefix] = Processor;
        T2IPromptHandling.PromptTagLengthEstimators[TagPrefix] = Estimator;
    }

    /// <summary>One file matched by a reference: where to read its prompt from, the WHERE filter built for
    /// this query against its schema, and how many rows pass that filter.</summary>
    private sealed record MatchedDataset(DatasetEntry Entry, string PromptColumn, SqlFilter Filter, long Count);

    private static string Processor(string data, T2IPromptHandling.PromptTagContext context)
    {
        WildcardQuery query;
        try
        {
            query = WildcardQueryParser.Parse(data);
        }
        catch (WildcardQueryException ex)
        {
            // A malformed <q:...> is a user error, not something to pass along — drop it (warn only when active
            // so a disabled extension doesn't spam old prompts that still contain q-tags).
            if (DatasetManager.IsActive)
            {
                context.TrackWarning($"Quarry: invalid reference '{data}': {ex.Message}");
            }
            return "";
        }
        List<DatasetEntry> targets = ResolveTargets(query.Name);
        if (targets.Count == 0)
        {
            if (DatasetManager.IsActive)
            {
                context.TrackWarning($"Quarry: no dataset matches '{query.Name}'.");
            }
            return "";
        }
        bool multi = IsMultiReference(query.Name);
        try
        {
            return ProcessTargets(query, targets, multi, context);
        }
        catch (WildcardQueryException ex)
        {
            context.TrackWarning($"Quarry '{query.Name}': {ex.Message}");
            return "";
        }
        catch (Exception ex)
        {
            context.TrackWarning($"Quarry '{query.Name}' failed: {ex.Message}");
            Logs.Error($"Quarry: error processing '{data}': {ex.ReadableString()}");
            return "";
        }
    }

    /// <summary>Matches a <c>&lt;q:...&gt;</c> reference tag (optional <c>[n]</c> / <c>[n-m]</c> count, like core),
    /// capturing the inner <c>NAME[query]</c> data. Reserved chars <c>&lt; &gt;</c> can't appear in a value, so
    /// stopping at the first <c>&gt;</c> is safe.</summary>
    private static readonly Regex ReferenceTagRegex =
        new(@"<q(?:\[\d+(?:-\d+)?\])?:([^>]*)>", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>Returns the distinct wildcard names of every dataset this extension would serve for the
    /// <c>q</c> references in <paramref name="prompt"/>, resolved with the exact same name
    /// handling as real expansion (comma lists, globs, fuzzy match) so the settings UI can flag precisely what
    /// would be used. Filters are ignored — only the NAME part matters. Never throws: an unparseable or
    /// non-matching tag is skipped.</summary>
    public static IReadOnlyList<string> ResolveReferencedDatasetNames(string prompt)
    {
        List<string> names = [];
        if (string.IsNullOrEmpty(prompt))
        {
            return names;
        }
        HashSet<string> seen = [];
        foreach (Match match in ReferenceTagRegex.Matches(prompt))
        {
            WildcardQuery query;
            try
            {
                query = WildcardQueryParser.Parse(match.Groups[1].Value);
            }
            catch (WildcardQueryException)
            {
                continue;
            }
            foreach (DatasetEntry entry in ResolveTargets(query.Name))
            {
                if (seen.Add(entry.WildcardName.ToLowerFast()))
                {
                    names.Add(entry.WildcardName);
                }
            }
        }
        return names;
    }

    /// <summary>Resolves a reference NAME to the datasets it targets. A NAME may be a comma-separated list and
    /// each part may be a glob (<c>quarry/*</c>): globs match every known dataset, a plain name resolves via
    /// the same fuzzy <see cref="T2IParamTypes.GetBestInList"/> SwarmUI uses for wildcards — but against our own
    /// dataset names, never the Wildcards folder. Results are de-duplicated by lowercased name, preserving
    /// discovery order.</summary>
    private static List<DatasetEntry> ResolveTargets(string name)
    {
        List<DatasetEntry> targets = [];
        HashSet<string> seen = [];
        foreach (string part in WildcardNameMatching.SplitNames(name))
        {
            if (WildcardNameMatching.IsGlob(part))
            {
                foreach (DatasetEntry entry in DatasetManager.AllDatasets.OrderBy(e => e.WildcardName, StringComparer.OrdinalIgnoreCase))
                {
                    if (WildcardNameMatching.GlobMatches(part, entry.WildcardName) && seen.Add(entry.WildcardName.ToLowerFast()))
                    {
                        targets.Add(entry);
                    }
                }
            }
            else
            {
                string card = T2IParamTypes.GetBestInList(part, DatasetManager.AllDatasetNames);
                if (card is not null && DatasetManager.Resolve(card) is DatasetEntry entry && seen.Add(entry.WildcardName.ToLowerFast()))
                {
                    targets.Add(entry);
                }
            }
        }
        return targets;
    }

    private static bool IsMultiReference(string name) => name.Contains(',') || WildcardNameMatching.IsGlob(name);

    private static string ProcessTargets(WildcardQuery query, List<DatasetEntry> targets, bool multi, T2IPromptHandling.PromptTagContext context)
    {
        List<MatchedDataset> matched = [];
        foreach (DatasetEntry entry in targets)
        {
            MatchedDataset plan;
            try
            {
                plan = Plan(query, entry, context);
            }
            catch (Exception ex) when (multi)
            {
                // In a fan-out, one unusable file (missing column, unreadable schema, …) must not abort the
                // rest. A single explicit reference still surfaces the error via the caller's catch.
                Logs.Debug($"Quarry: skipping '{entry.WildcardName}' in '{query.Name}': {ex.Message}");
                continue;
            }
            if (plan is not null && plan.Count > 0)
            {
                matched.Add(plan);
            }
        }
        if (matched.Count == 0)
        {
            return "";
        }
        (int picks, string separator) = T2IPromptHandling.InterpretPredataForRandom("random", context.PreData, query.Name, context);
        if (separator is null)
        {
            return null;
        }
        // Quarry tracks its own contributions in `used_quarry` (kept separate from core's `used_wildcards`),
        // so a <q:...> datafile is reported distinctly from a real wildcard. Core serializes every ExtraMeta
        // key into the saved image metadata, so this surfaces there automatically.
        List<string> usedQuarry = context.Input.ExtraMeta.GetOrCreate("used_quarry", () => new List<string>()) as List<string>;

        bool indexBehavior = context.Input.Get(T2IParamTypes.WildcardSeedBehavior, "Random") == "Index";
        Func<long> nextIndex = indexBehavior
            ? () => context.Input.GetWildcardSeed()
            : () => context.Input.GetWildcardRandom().Next();

        // Pool every matching row across the matched files: a global index in [0, total) maps into whichever
        // file's row range contains it, so larger files contribute proportionally more picks.
        long total = 0;
        long[] offsets = new long[matched.Count];
        for (int i = 0; i < matched.Count; i++)
        {
            offsets[i] = total;
            total += matched[i].Count;
        }

        // Record a file in the used_quarry metadata only when a pick actually lands on it — not every
        // candidate of a comma/glob fan-out — so the saved metadata reports what truly contributed. First-hit order.
        List<string> hitOrdered = [];
        HashSet<string> hit = [];

        string result = WildcardSelection.Pick(
            total,
            picks,
            separator,
            nextIndex,
            globalIndex =>
            {
                int i = LocateDataset(offsets, globalIndex);
                MatchedDataset m = matched[i];
                long localIndex = globalIndex - offsets[i];
                // Fetch the picked row. Datasets are blank-filtered at ingest, so the prompt column is
                // non-empty — but a dataset added without that cleanup could still hold a blank row. Probe a
                // few rows forward (deterministic, so it also holds under the Index seed behavior) so a stray
                // blank doesn't surface as an empty expansion; the warning below is the last-resort backstop.
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
                if (value.Length == 0)
                {
                    Logs.Warning(
                        $"Quarry wildcard '{m.Entry.WildcardName}': blank result from prompt column '{m.PromptColumn}' near row {localIndex} (file '{m.Entry.Path}').");
                }
                else if (hit.Add(m.Entry.WildcardName))
                {
                    hitOrdered.Add(m.Entry.WildcardName);
                }
                return value;
            });

        foreach (string name in hitOrdered)
        {
            if (!usedQuarry.Contains(name))
            {
                usedQuarry.Add(name);
            }
        }
        return result;
    }

    /// <summary>Builds the per-file selection plan, or null when the file has no prompt column to read.</summary>
    private static MatchedDataset Plan(WildcardQuery query, DatasetEntry entry, T2IPromptHandling.PromptTagContext context)
    {
        ColumnSchema schema = DatasetManager.GetSchema(entry);
        string promptColumn = PromptColumnResolver.Resolve(DatasetManager.GetConfiguredPromptColumn(entry.WildcardName), schema);
        if (promptColumn is null)
        {
            context.TrackWarning($"Quarry wildcard '{entry.WildcardName}' has no columns to read.");
            return null;
        }
        // No configured tag columns (or a single-column prompt file) → the prompt column doubles as the tag
        // column, so `[tags=…]` still works without any per-file setup.
        List<ColumnInfo> tagColumns = TagColumnResolver.Resolve(DatasetManager.GetConfiguredTagColumns(entry.WildcardName), schema, promptColumn);
        SqlFilter filter = SqlFilterBuilder.Build(query, schema, tagColumns);
        // Size the pick pool. With no [query] filter (the common case) this is the dataset's invariant row
        // total, served from the warmed cache — and the matching GetPromptAt fetch is then a bare LIMIT/OFFSET
        // that DuckDB's lance scan pushes down to a native O(1) row seek. A non-empty [query] filter is
        // dataset-specific, so it must be counted live and the fetch scans (inherent to filtering, and the
        // uncommon path). Blank prompt rows are excluded at ingest, so the raw total is the usable-pick total;
        // ProcessTargets still probes past any stray blank in a dataset that skipped that cleanup.
        long count = filter.IsEmpty
            ? DatasetManager.GetRowCount(entry, promptColumn)
            : DatasetManager.Backend.CountRows(entry.Path, filter);
        return new MatchedDataset(entry, promptColumn, filter, count);
    }

    /// <summary>Finds the index of the file whose pooled row range contains <paramref name="globalIndex"/>.</summary>
    private static int LocateDataset(long[] offsets, long globalIndex)
    {
        for (int i = offsets.Length - 1; i >= 0; i--)
        {
            if (globalIndex >= offsets[i])
            {
                return i;
            }
        }
        return 0;
    }

    /// <summary>Length estimate for a <c>&lt;q:...&gt;</c> tag. A queried dataset row can't be estimated cheaply
    /// and an unmatched tag is dropped, so either way it contributes nothing — return empty.</summary>
    private static string Estimator(string data, T2IPromptHandling.PromptTagContext context) => "";
}
