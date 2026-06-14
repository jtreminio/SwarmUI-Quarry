using FreneticUtilities.FreneticExtensions;
using SwarmUI.Text2Image;
using SwarmUI.Utils;

namespace Quarry;

/// <summary>Hooks SwarmUI's <c>wildcard</c>/<c>wc</c> prompt-tag processors: captures the currently
/// registered delegate and replaces it with one that serves our datasets via DuckDB, falling back to
/// the captured delegate for every other wildcard. This chains cleanly with core and with other
/// extensions (e.g. WhatTheDuck) regardless of init order — we only claim names we own.</summary>
public static class WildcardHandler
{
    private static Func<string, T2IPromptHandling.PromptTagContext, string> _originalProcessor;
    private static Func<string, T2IPromptHandling.PromptTagContext, string> _originalEstimator;

    public static void Initialize()
    {
        if (T2IPromptHandling.PromptTagProcessors.TryGetValue("wildcard", out Func<string, T2IPromptHandling.PromptTagContext, string> processor))
        {
            _originalProcessor = processor;
        }
        if (T2IPromptHandling.PromptTagLengthEstimators.TryGetValue("wildcard", out Func<string, T2IPromptHandling.PromptTagContext, string> estimator))
        {
            _originalEstimator = estimator;
        }
        T2IPromptHandling.PromptTagProcessors["wildcard"] = Processor;
        T2IPromptHandling.PromptTagProcessors["wc"] = Processor;
        T2IPromptHandling.PromptTagLengthEstimators["wildcard"] = Estimator;
        T2IPromptHandling.PromptTagLengthEstimators["wc"] = Estimator;
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
        catch (WildcardQueryException)
        {
            return Chain(data, context);
        }
        List<DatasetEntry> targets = ResolveTargets(query.Name);
        if (targets.Count == 0)
        {
            return Chain(data, context);
        }
        bool multi = IsMultiReference(query.Name);
        try
        {
            return ProcessTargets(query, targets, multi, context);
        }
        catch (WildcardQueryException ex)
        {
            context.TrackWarning($"Quarry wildcard '{query.Name}': {ex.Message}");
            return "";
        }
        catch (Exception ex)
        {
            context.TrackWarning($"Quarry wildcard '{query.Name}' failed: {ex.Message}");
            Logs.Error($"Quarry: error processing '{data}': {ex.ReadableString()}");
            return "";
        }
    }

    /// <summary>Resolves a reference NAME to the datasets it targets. A NAME may be a comma-separated list and
    /// each part may be a glob (<c>quarry/*</c>): globs match every known dataset, a plain name resolves via
    /// the same fuzzy <see cref="T2IParamTypes.GetBestInList"/> used for single references. Results are
    /// de-duplicated by lowercased name, preserving discovery order.</summary>
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
                string card = T2IParamTypes.GetBestInList(part, WildcardsHelper.ListFiles);
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
        List<string> usedWildcards = context.Input.ExtraMeta.GetOrCreate("used_wildcards", () => new List<string>()) as List<string>;
        foreach (MatchedDataset m in matched)
        {
            usedWildcards.Add(m.Entry.WildcardName);
        }

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

        return WildcardSelection.Pick(
            total,
            picks,
            separator,
            nextIndex,
            globalIndex =>
            {
                int i = LocateDataset(offsets, globalIndex);
                MatchedDataset m = matched[i];
                long localIndex = globalIndex - offsets[i];
                string result = context.Parse(DatasetManager.Backend.GetPromptAt(m.Entry.Path, m.PromptColumn, m.Filter, localIndex)).Trim();
                if (result.Length == 0)
                {
                    Logs.Warning(
                        $"Quarry wildcard '{m.Entry.WildcardName}': blank result from prompt column '{m.PromptColumn}' at row {localIndex} (file '{m.Entry.Path}').");
                }
                return result;
            });
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
        long count = DatasetManager.Backend.CountRows(entry.Path, filter);
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

    private static string Estimator(string data, T2IPromptHandling.PromptTagContext context)
    {
        string name;
        try
        {
            name = WildcardQueryParser.Parse(data).Name;
        }
        catch (WildcardQueryException)
        {
            return ChainEstimator(data, context);
        }
        if (ResolveTargets(name).Count > 0)
        {
            return ""; // length of a queried dataset row can't be estimated cheaply
        }
        return ChainEstimator(data, context);
    }

    private static string Chain(string data, T2IPromptHandling.PromptTagContext context)
        => _originalProcessor is not null ? _originalProcessor(data, context) : null;

    private static string ChainEstimator(string data, T2IPromptHandling.PromptTagContext context)
        => _originalEstimator is not null ? _originalEstimator(data, context) : "";
}
