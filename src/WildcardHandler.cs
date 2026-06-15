using System.Text.RegularExpressions;
using FreneticUtilities.FreneticExtensions;
using SwarmUI.Text2Image;
using SwarmUI.Utils;

namespace Quarry;

/// <summary>Registers and serves Quarry's <c>&lt;q:NAME[query]&gt;</c> prompt-tag from our datasets via DuckDB.
/// The <c>q</c> prefix is exclusively Quarry's — it never chains to core's <c>wc</c>/<c>wildcard</c> handlers;
/// a non-matching <c>q</c> reference is dropped (with a warning only when the extension is active).</summary>
public static class WildcardHandler
{
    public const string TagPrefix = "q";

    public static void Initialize()
    {
        T2IPromptHandling.PromptTagProcessors[TagPrefix] = Processor;
        T2IPromptHandling.PromptTagLengthEstimators[TagPrefix] = Estimator;
    }

    private static string Processor(string data, T2IPromptHandling.PromptTagContext context)
    {
        WildcardQuery query;
        try
        {
            query = WildcardQueryParser.Parse(data);
        }
        catch (WildcardQueryException ex)
        {
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

    /// <summary>Matches a <c>&lt;q:...&gt;</c> tag (optional <c>[n]</c> / <c>[n-m]</c> count, like core),
    /// capturing the inner <c>NAME[query]</c>. Reserved chars <c>&lt; &gt;</c> can't appear in a value, so
    /// stopping at the first <c>&gt;</c> is safe.</summary>
    private static readonly Regex ReferenceTagRegex =
        new(@"<q(?:\[\d+(?:-\d+)?\])?:([^>]*)>", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>The distinct wildcard names of every dataset that would serve the <c>q</c> references in
    /// <paramref name="prompt"/>, resolved with the same name handling as real expansion so the settings UI can
    /// flag what would be used. Filters are ignored; an unparseable or non-matching tag is skipped.</summary>
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

    /// <summary>Resolves a reference NAME (comma list and/or globs) to the datasets it targets. A glob matches
    /// every known dataset; a plain name resolves via the same fuzzy <see cref="T2IParamTypes.GetBestInList"/>
    /// SwarmUI uses for wildcards, but against our dataset names, never the Wildcards folder. De-duplicated by
    /// lowercased name, preserving discovery order.</summary>
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
        // Pass 1 (scan-free): resolve each target's prompt column and build its filter from the cached schema.
        // In a fan-out, one unusable file must not abort the rest; a single explicit reference still surfaces
        // its error via the caller's catch.
        List<PlanDraft> drafts = [];
        foreach (DatasetEntry entry in targets)
        {
            PlanDraft draft;
            try
            {
                draft = DraftPlan(query, entry, context);
            }
            catch (Exception ex) when (multi)
            {
                Logs.Debug($"Quarry: skipping '{entry.WildcardName}' in '{query.Name}': {ex.Message}");
                continue;
            }
            if (draft is not null)
            {
                drafts.Add(draft);
            }
        }
        // A filtered count is a live scan (the filter defeats both the cached total and Lance's count
        // pushdown). For a fan-out, warm them in parallel so the query costs about its slowest single dataset.
        if (multi)
        {
            DatasetManager.WarmFilteredCounts([.. drafts.Where(draft => !draft.Filter.IsEmpty).Select(draft => (draft.Entry, draft.Filter))]);
        }
        // Pass 2: size each dataset's pick pool from the (now warm) counts.
        List<MatchedDataset> matched = [];
        foreach (PlanDraft draft in drafts)
        {
            MatchedDataset plan;
            try
            {
                long count = ResolveCount(draft, multi);
                if (count <= 0)
                {
                    continue;
                }
                // With a filter, the unfiltered total (a cached metadata read) lets the fetch gauge
                // selectivity; with none it equals the count.
                long totalRows = draft.Filter.IsEmpty ? count : DatasetManager.GetRowCount(draft.Entry, draft.PromptColumn);
                plan = new MatchedDataset(draft.Entry, draft.PromptColumn, draft.Filter, count, totalRows);
            }
            catch (Exception ex) when (multi)
            {
                Logs.Debug($"Quarry: skipping '{draft.Entry.WildcardName}' in '{query.Name}': {ex.Message}");
                continue;
            }
            matched.Add(plan);
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
        // Quarry tracks its contributions in `used_quarry`, kept separate from core's `used_wildcards`. Core
        // serializes every ExtraMeta key into the saved image metadata, so this surfaces there automatically.
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

        // Record a file in used_quarry only when a pick actually lands on it (not every fan-out candidate), in
        // first-hit order.
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
                string value = PromptSampler.Fetch(m, localIndex, globalIndex, context);
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

    private sealed record PlanDraft(DatasetEntry Entry, string PromptColumn, SqlFilter Filter);

    private static PlanDraft DraftPlan(WildcardQuery query, DatasetEntry entry, T2IPromptHandling.PromptTagContext context)
    {
        ColumnSchema schema = DatasetManager.GetSchema(entry);
        string promptColumn = PromptColumnResolver.Resolve(DatasetManager.GetConfiguredPromptColumn(entry.WildcardName), schema);
        if (promptColumn is null)
        {
            context.TrackWarning($"Quarry wildcard '{entry.WildcardName}' has no columns to read.");
            return null;
        }
        // No configured tag columns → the prompt column doubles as the tag column, so `[tags=…]` still works
        // without any per-file setup.
        List<ColumnInfo> tagColumns = TagColumnResolver.Resolve(DatasetManager.GetConfiguredTagColumns(entry.WildcardName), schema, promptColumn);
        SqlFilter filter = SqlFilterBuilder.Build(query, schema, tagColumns);
        return new PlanDraft(entry, promptColumn, filter);
    }

    /// <summary>Sizes a draft's pick pool. No filter → the invariant total from the warm cache. A filter in a
    /// fan-out reads back the count warmed in parallel (a miss means its count failed → 0, dropped); a single
    /// explicit reference counts directly so any error surfaces.</summary>
    private static long ResolveCount(PlanDraft draft, bool multi)
    {
        if (draft.Filter.IsEmpty)
        {
            return DatasetManager.GetRowCount(draft.Entry, draft.PromptColumn);
        }
        if (multi)
        {
            return DatasetManager.TryGetFilteredCount(draft.Entry, draft.Filter, out long count) ? count : 0;
        }
        return DatasetManager.CountRowsFiltered(draft.Entry, draft.Filter);
    }

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

    // A queried row can't be estimated cheaply and an unmatched tag is dropped, so either way it contributes
    // nothing.
    private static string Estimator(string data, T2IPromptHandling.PromptTagContext context) => "";
}
