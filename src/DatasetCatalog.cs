using System.IO;
using Newtonsoft.Json;

namespace Quarry;

public sealed record DatasetAttribution(string Name, string? Alias, string SourceUrl);

public static class DatasetCatalog
{
    public static IReadOnlyList<DatasetAttribution> Entries { get; } = Load();
    private static readonly Dictionary<string, string> Names = BuildNames(Entries);

    private static DatasetAttribution[] Load()
    {
        using Stream stream = typeof(DatasetCatalog).Assembly.GetManifestResourceStream("Quarry.DatasetSources.json")
            ?? throw new InvalidOperationException("Missing Quarry dataset source catalog.");
        using StreamReader reader = new(stream);
        return JsonConvert.DeserializeObject<DatasetAttribution[]>(reader.ReadToEnd());
    }

    internal static Dictionary<string, string> BuildNames(IEnumerable<DatasetAttribution> entries)
    {
        Dictionary<string, string> names = new(StringComparer.OrdinalIgnoreCase);
        foreach (DatasetAttribution entry in entries)
        {
            names.Add(entry.Name, entry.Name);
            if (entry.Alias is not null)
            {
                names.Add(entry.Alias, entry.Name);
            }
        }
        foreach (var group in names.ToArray().GroupBy(pair => pair.Key[(pair.Key.LastIndexOf('/') + 1)..], StringComparer.OrdinalIgnoreCase))
        {
            string[] targets = [.. group.Select(pair => pair.Value).Distinct(StringComparer.OrdinalIgnoreCase)];
            if (targets.Length == 1)
            {
                names.TryAdd(group.Key, targets[0]);
            }
        }
        return names;
    }

    public static string CanonicalName(string name)
        => name is not null && Names.TryGetValue(name, out string canonical) ? canonical : name;

    public static string LocalPath(string repoPath)
        => CanonicalName(DatasetNaming.ToName(repoPath)) + Path.GetExtension(repoPath);
}
