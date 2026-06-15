using FreneticUtilities.FreneticExtensions;
using SwarmUI.Utils;

namespace Quarry;

public static class DatasetWarmer
{
    private static int Parallelism => Math.Clamp(Environment.ProcessorCount / 2, 2, 6);

    public static int WarmAll(DuckDbQueryBackend backend, IReadOnlyCollection<DatasetEntry> datasets, int previewLimit)
    {
        List<DatasetEntry> pending = [.. datasets.Where(entry =>
            !DatasetCache.IsFullyCached(entry.WildcardName.ToLowerFast(), entry.FileHash, ColumnConfig.GetPromptColumn(entry.WildcardName), previewLimit))];
        if (pending.Count == 0)
        {
            return 0;
        }
        List<Action<IDatasetReader>> jobs = [.. pending.Select(entry => (Action<IDatasetReader>)(reader => WarmOne(reader, entry, previewLimit)))];
        backend.RunPooled(jobs, Parallelism);
        DatasetCache.PersistIfDirty();
        Logs.Info($"Quarry: warmed {pending.Count} dataset(s).");
        return pending.Count;
    }

    public static void WarmFilteredCounts(DuckDbQueryBackend backend, IReadOnlyList<(DatasetEntry Entry, SqlFilter Filter)> requests)
    {
        List<(DatasetEntry Entry, SqlFilter Filter)> misses = [.. requests.Where(request =>
            !request.Filter.IsEmpty && !DatasetCache.TryGetFilteredCount(DatasetCache.FilteredCountKey(request.Entry, request.Filter), out _))];
        if (misses.Count == 0)
        {
            return;
        }
        if (misses.Count == 1)
        {
            try
            {
                DatasetManager.CountRowsFiltered(misses[0].Entry, misses[0].Filter);
            }
            catch (Exception ex)
            {
                Logs.Debug($"Quarry: filtered count failed for '{misses[0].Entry.WildcardName}': {ex.Message}");
            }
            return;
        }
        List<Action<IDatasetReader>> jobs = [];
        foreach ((DatasetEntry entry, SqlFilter filter) in misses)
        {
            jobs.Add(reader =>
            {
                try
                {
                    DatasetCache.StoreFilteredCount(DatasetCache.FilteredCountKey(entry, filter), reader.CountRows(entry.Path, filter));
                }
                catch (Exception ex)
                {
                    Logs.Debug($"Quarry: filtered count failed for '{entry.WildcardName}': {ex.Message}");
                }
            });
        }
        backend.RunPooled(jobs, Parallelism);
        DatasetCache.PersistIfDirty();
    }

    private static void WarmOne(IDatasetReader reader, DatasetEntry entry, int limit)
    {
        string key = entry.WildcardName.ToLowerFast();
        try
        {
            ColumnSchema schema = reader.GetSchema(entry.Path);
            DatasetCache.StoreSchema(key, entry.FileHash, schema);
            string resolved = PromptColumnResolver.Resolve(ColumnConfig.GetPromptColumn(entry.WildcardName), schema) ?? "";
            long count = reader.CountRows(entry.Path, SqlFilter.None);
            DatasetCache.StoreRowCount(key, entry.FileHash, resolved, count);
            (List<string> columns, List<List<string>> rows) = reader.GetSampleRows(entry.Path, limit);
            DatasetCache.StorePreview(key, entry.FileHash, new DatasetCache.PreviewData(limit, columns, rows));
        }
        catch (Exception ex)
        {
            Logs.Debug($"Quarry: warm failed for '{entry.WildcardName}': {ex.Message}");
        }
    }
}
