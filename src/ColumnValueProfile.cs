using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using SwarmUI.Utils;

namespace Quarry;

public sealed record ExploreLimits(int UniqueValues, int ValueLength, double MaxDistinctPercent = 10)
{
    public const int DefaultUniqueValues = 10000;
    public const int DefaultValueLength = 256;
    public const double DefaultDistinctPercent = 10;
    public const int MaxUniqueValues = 50000;
    public const int MaxValueLength = 1000;

    public void Validate()
    {
        if (UniqueValues < 2 || UniqueValues > MaxUniqueValues || ValueLength < 2 || ValueLength > MaxValueLength
            || !double.IsFinite(MaxDistinctPercent) || MaxDistinctPercent < 0.1 || MaxDistinctPercent > 100)
        {
            throw new QueryException($"Explore limits must be between 2 and {MaxUniqueValues} distinct values, 2 and {MaxValueLength} characters, and 0.1% and 100% distinct values per row.");
        }
    }
}

public sealed record ColumnValueProfile(bool Eligible, string Reason, IReadOnlyList<string> Values, long? TotalRows = null, int? DistinctCount = null)
{
    public string Revision { get; init; } = "";

    public static ColumnValueProfile Rejected(string reason) => new(false, reason, []);

    // Bounded equivalent of COUNT(DISTINCT value) and MAX(length(value)). A
    // passing result requires exhaustion of the entire column; failure can stop
    // early. Original casing is restored by the reader before values reach here.
    internal static ColumnValueProfile Analyze(IEnumerable<string> values, ExploreLimits limits)
    {
        limits.Validate();
        HashSet<string> distinct = new(StringComparer.Ordinal);
        long rows = 0;
        foreach (string value in values)
        {
            rows++;
            if (string.IsNullOrEmpty(value))
            {
                continue;
            }
            int length = 0;
            foreach (Rune _ in value.EnumerateRunes())
            {
                if (++length >= limits.ValueLength)
                {
                    return Rejected("length_limit");
                }
            }
            distinct.Add(value);
            if (distinct.Count >= limits.UniqueValues)
            {
                return Rejected("distinct_limit");
            }
        }
        if (distinct.Count == 0)
        {
            return new(false, "empty", [], rows, 0);
        }
        if ((decimal)distinct.Count * 100 > (decimal)rows * (decimal)limits.MaxDistinctPercent)
        {
            return new(false, "percentage_limit", [], rows, distinct.Count);
        }
        return new(true, "", [.. distinct.OrderBy(v => v, StringComparer.Ordinal)], rows, distinct.Count);
    }
}

public sealed class ColumnProfileCache(string directory)
{
    private const int FormatVersion = 1;
    private sealed record Entry(int Version, string Source, string Column, string Fingerprint, ExploreLimits Limits, ColumnValueProfile Profile);
    private readonly ConcurrentDictionary<string, Entry> _memory = new();
    private readonly SingleFlight<string, ColumnValueProfile> _flight = new();

    public ColumnValueProfile Get(string path, string column, ExploreLimits limits, Func<ColumnValueProfile> analyze)
    {
        limits.Validate();
        string source = Path.GetFullPath(path);
        string fingerprint = DatasetManager.ComputeHash(source);
        if (fingerprint == "unknown")
        {
            throw new QueryException("Cannot check the dataset version. Refresh the dataset and try again.");
        }
        string key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new[] { source, column }))));
        bool Matches(Entry entry) => entry is not null && entry.Version == FormatVersion && entry.Source == source
            && entry.Column == column && entry.Fingerprint == fingerprint && entry.Limits == limits && entry.Profile?.Values is not null && !string.IsNullOrEmpty(entry.Profile.Revision);
        return _flight.GetOrBuild($"{key}|{fingerprint}|{limits}", () =>
        {
            if (_memory.TryGetValue(key, out Entry memory) && Matches(memory))
            {
                return memory.Profile;
            }
            string file = Path.Combine(directory, key + ".json");
            try
            {
                if (File.Exists(file))
                {
                    Entry saved = JsonSerializer.Deserialize<Entry>(File.ReadAllText(file));
                    if (Matches(saved))
                    {
                        _memory[key] = saved;
                        return saved.Profile;
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
            {
                Logs.Debug($"Quarry: ignoring unreadable column profile cache: {ex.Message}");
            }
            ColumnValueProfile profile = analyze() with
            {
                Revision = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(fingerprint + JsonSerializer.Serialize(limits))))
            };
            if (DatasetManager.ComputeHash(source) != fingerprint)
            {
                throw new QueryException("The dataset changed while checking values. Try again.");
            }
            Entry result = new(FormatVersion, source, column, fingerprint, limits, profile);
            _memory[key] = result;
            try
            {
                Directory.CreateDirectory(directory);
                string temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try
                {
                    File.WriteAllText(temporary, JsonSerializer.Serialize(result));
                    File.Move(temporary, file, overwrite: true);
                }
                finally
                {
                    if (File.Exists(temporary))
                    {
                        File.Delete(temporary);
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Logs.Warning($"Quarry: could not persist column profile cache: {ex.Message}");
            }
            return profile;
        });
    }
}
