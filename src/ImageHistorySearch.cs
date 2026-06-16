using Newtonsoft.Json.Linq;
using SwarmUI.Utils;

namespace Quarry;

public sealed record ImageSearchResult(bool HasIndex, List<string> Columns, List<List<string>> Rows, long Total);

public static class ImageHistorySearch
{
    private static readonly ConcurrentDictionary<string, List<string>> DiscoveredCache = new();

    private static readonly HashSet<string> Sortable =
        new(ImageHistoryIndex.ResultColumns, StringComparer.OrdinalIgnoreCase);

    public static ImageSearchResult Search(string userId, JArray filters, string sortBy, bool sortDescending, int limit, int offset)
    {
        if (!ImageHistoryIndex.Exists(userId))
        {
            return new ImageSearchResult(false, [], [], 0);
        }
        string lancePath = ImageHistoryIndex.LancePathFor(userId);
        SqlFilter filter = ImageSearchFilterBuilder.Build(filters);
        string sortColumn = ResolveSort(sortBy);
        (List<string> columns, List<List<string>> rows) =
            DatasetManager.Backend.GetFilteredRows(lancePath, ImageHistoryIndex.ResultColumns, filter, sortColumn, sortDescending, limit, offset);
        long total = offset == 0 && rows.Count < limit
            ? rows.Count
            : DatasetManager.Backend.CountRows(lancePath, filter);
        return new ImageSearchResult(true, columns, rows, total);
    }

    public static (IReadOnlyList<ImageSearchField> Core, IReadOnlyList<string> Discovered) Fields(string userId)
        => (ImageHistoryIndex.CoreFields, Discovered(userId));

    public static void InvalidateFields(string userId)
        => DiscoveredCache.TryRemove(ImageHistoryIndex.SafeUserSegment(userId), out _);

    private static List<string> Discovered(string userId)
    {
        if (!ImageHistoryIndex.Exists(userId))
        {
            return [];
        }
        string key = ImageHistoryIndex.SafeUserSegment(userId);
        if (DiscoveredCache.TryGetValue(key, out List<string> cached))
        {
            return cached;
        }
        List<string> keys;
        try
        {
            keys = DatasetManager.Backend.ListDiscoveredFields(ImageHistoryIndex.LancePathFor(userId), ImageHistoryIndex.MetaJsonColumn);
        }
        catch (Exception ex)
        {
            Logs.Warning($"Quarry: could not enumerate discovered image-history fields: {ex.Message}");
            return [];
        }
        HashSet<string> coreColumns = new(ImageHistoryIndex.CoreFields.Select(f => f.Column), StringComparer.OrdinalIgnoreCase);
        List<string> discovered =
        [
            .. keys.Where(k => !string.IsNullOrWhiteSpace(k) && !coreColumns.Contains(k))
                   .Distinct(StringComparer.OrdinalIgnoreCase)
                   .OrderBy(k => k, StringComparer.OrdinalIgnoreCase),
        ];
        DiscoveredCache[key] = discovered;
        return discovered;
    }

    internal static string ResolveSort(string sortBy)
    {
        if (string.IsNullOrWhiteSpace(sortBy))
        {
            return "mtime";
        }
        string normalized = sortBy.Trim().ToLowerInvariant();
        return normalized switch
        {
            "date" => "mtime",
            "name" => "path",
            _ => Sortable.Contains(normalized) ? normalized : "mtime",
        };
    }
}
