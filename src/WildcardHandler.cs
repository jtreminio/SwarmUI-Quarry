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
        string card = T2IParamTypes.GetBestInList(query.Name, WildcardsHelper.ListFiles);
        if (card is null || DatasetManager.Resolve(card) is not DatasetEntry entry)
        {
            return Chain(data, context);
        }
        try
        {
            return ProcessDataset(query, entry, context);
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

    private static string ProcessDataset(WildcardQuery query, DatasetEntry entry, T2IPromptHandling.PromptTagContext context)
    {
        ColumnSchema schema = DatasetManager.GetSchema(entry);
        string promptColumn = PromptColumnResolver.Resolve(DatasetManager.GetConfiguredPromptColumn(entry.WildcardName), schema);
        if (promptColumn is null)
        {
            context.TrackWarning($"Quarry wildcard '{entry.WildcardName}' has no columns to read.");
            return "";
        }
        SqlFilter filter = SqlFilterBuilder.Build(query, schema);
        long total = DatasetManager.Backend.CountRows(entry.Path, filter);
        if (total <= 0)
        {
            return "";
        }
        (int picks, string separator) = T2IPromptHandling.InterpretPredataForRandom("random", context.PreData, entry.WildcardName, context);
        if (separator is null)
        {
            return null;
        }
        (context.Input.ExtraMeta.GetOrCreate("used_wildcards", () => new List<string>()) as List<string>).Add(entry.WildcardName);

        bool indexBehavior = context.Input.Get(T2IParamTypes.WildcardSeedBehavior, "Random") == "Index";
        Func<long> nextIndex = indexBehavior
            ? () => context.Input.GetWildcardSeed()
            : () => context.Input.GetWildcardRandom().Next();

        return WildcardSelection.Pick(
            total,
            picks,
            separator,
            nextIndex,
            index => context.Parse(DatasetManager.Backend.GetPromptAt(entry.Path, promptColumn, filter, index)).Trim());
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
        string card = T2IParamTypes.GetBestInList(name, WildcardsHelper.ListFiles);
        if (card is not null && DatasetManager.Resolve(card) is not null)
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
