using System.Text.RegularExpressions;
using FreneticUtilities.FreneticExtensions;
using SwarmUI.Text2Image;
using SwarmUI.Utils;

namespace Quarry;

public static class PromptTagHandler
{
    public const string TagPrefix = "q";

    public static void Initialize()
    {
        T2IPromptHandling.PromptTagProcessors[TagPrefix] = Processor;
        T2IPromptHandling.PromptTagLengthEstimators[TagPrefix] = Estimator;
    }

    private static string Processor(string data, T2IPromptHandling.PromptTagContext context)
    {
        Query query;
        try
        {
            query = QueryParser.Parse(data);
        }
        catch (QueryException ex)
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
        catch (QueryException ex)
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

    private static readonly Regex ReferenceTagRegex =
        new(@"<q(?:\[\d+(?:-\d+)?\])?:([^>]*)>", RegexOptions.Compiled | RegexOptions.IgnoreCase);

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
            Query query;
            try
            {
                query = QueryParser.Parse(match.Groups[1].Value);
            }
            catch (QueryException)
            {
                continue;
            }
            foreach (DatasetEntry entry in ResolveTargets(query.Name))
            {
                if (seen.Add(entry.Name.ToLowerFast()))
                {
                    names.Add(entry.Name);
                }
            }
        }
        return names;
    }

    private static List<DatasetEntry> ResolveTargets(string name)
    {
        List<DatasetEntry> targets = [];
        HashSet<string> seen = [];
        foreach (string part in DatasetNameMatching.SplitNames(name))
        {
            if (DatasetNameMatching.IsGlob(part))
            {
                foreach (DatasetEntry entry in DatasetManager.AllDatasets.OrderBy(e => e.Name, StringComparer.OrdinalIgnoreCase))
                {
                    if (DatasetNameMatching.GlobMatches(part, entry.Name) && seen.Add(entry.Name.ToLowerFast()))
                    {
                        targets.Add(entry);
                    }
                }
            }
            else
            {
                string card = T2IParamTypes.GetBestInList(part, DatasetManager.AllDatasetNames);
                if (card is not null && DatasetManager.Resolve(card) is DatasetEntry entry && seen.Add(entry.Name.ToLowerFast()))
                {
                    targets.Add(entry);
                }
            }
        }
        return targets;
    }

    private static bool IsMultiReference(string name) => name.Contains(',') || DatasetNameMatching.IsGlob(name);

    private static string ProcessTargets(Query query, List<DatasetEntry> targets, bool multi, T2IPromptHandling.PromptTagContext context)
    {
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
                Logs.Debug($"Quarry: skipping '{entry.Name}' in '{query.Name}': {ex.Message}");
                continue;
            }
            if (draft is not null)
            {
                drafts.Add(draft);
            }
        }
        if (multi)
        {
            DatasetManager.WarmFilteredCounts([.. drafts.Where(draft => !draft.Filter.IsEmpty).Select(draft => (draft.Entry, draft.Filter))]);
        }
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
                long totalRows = draft.Filter.IsEmpty ? count : DatasetManager.GetRowCount(draft.Entry, draft.PromptColumn);
                plan = new MatchedDataset(draft.Entry, draft.PromptColumn, draft.Filter, count, totalRows);
            }
            catch (Exception ex) when (multi)
            {
                Logs.Debug($"Quarry: skipping '{draft.Entry.Name}' in '{query.Name}': {ex.Message}");
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
        List<string> usedQuarry = context.Input.ExtraMeta.GetOrCreate("used_quarry", () => new List<string>()) as List<string>;

        bool indexBehavior = context.Input.Get(T2IParamTypes.WildcardSeedBehavior, "Random") == "Index";
        Func<long> nextIndex = indexBehavior
            ? () => context.Input.GetWildcardSeed()
            : () => context.Input.GetWildcardRandom().Next();

        long total = 0;
        long[] offsets = new long[matched.Count];
        for (int i = 0; i < matched.Count; i++)
        {
            offsets[i] = total;
            total += matched[i].Count;
        }

        List<string> hitOrdered = [];
        HashSet<string> hit = [];

        string result = RandomSelection.Pick(
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
                        $"Quarry dataset '{m.Entry.Name}': blank result from prompt column '{m.PromptColumn}' near row {localIndex} (file '{m.Entry.Path}').");
                }
                else if (hit.Add(m.Entry.Name))
                {
                    hitOrdered.Add(m.Entry.Name);
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

    private static PlanDraft DraftPlan(Query query, DatasetEntry entry, T2IPromptHandling.PromptTagContext context)
    {
        ColumnSchema schema = DatasetManager.GetSchema(entry);
        string promptColumn = PromptColumnResolver.Resolve(
            query.PromptColumn, DatasetManager.GetConfiguredPromptColumn(entry.Name), schema);
        if (promptColumn is null)
        {
            context.TrackWarning($"Quarry dataset '{entry.Name}' has no columns to read.");
            return null;
        }
        List<ColumnInfo> tagColumns = TagColumnResolver.Resolve(DatasetManager.GetConfiguredTagColumns(entry.Name), schema, promptColumn);
        SqlFilter filter = SqlFilterBuilder.Build(query, schema, tagColumns);
        return new PlanDraft(entry, promptColumn, filter);
    }

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

    private static string Estimator(string data, T2IPromptHandling.PromptTagContext context) => "";
}
