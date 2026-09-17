using System.IO;
using System.Security.Cryptography;
using Newtonsoft.Json.Linq;

namespace Quarry;

internal sealed record StorageLayout(Dictionary<string, string> Columns, IReadOnlyList<SearchHelper> Helpers,
    bool SnapshotMatches = false, bool CanUseSearchHelpers = false);

/// <summary>Versioned casing and nested search storage metadata.</summary>
internal static class CasingStorage
{
    public const string DescriptorName = "quarry-storage.json";
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static Dictionary<string, string> Load(string datasetPath) => LoadLayout(datasetPath).Columns;

    public static StorageLayout LoadLayout(string datasetPath)
    {
        Dictionary<string, string> columns = new(StringComparer.OrdinalIgnoreCase);
        string path = Path.Combine(datasetPath, DescriptorName);
        if (!File.Exists(path))
        {
            return new(columns, []);
        }
        try
        {
            JObject descriptor = JObject.Parse(File.ReadAllText(path));
            int? version = descriptor.Value<int?>("version");
            if (version is not (1 or 2) || descriptor["columns"] is not JObject mappings)
            {
                throw new InvalidDataException("Unsupported casing storage version or missing columns.");
            }
            HashSet<string> names = new(StringComparer.OrdinalIgnoreCase);
            foreach (JProperty mapping in mappings.Properties())
            {
                if (mapping.Value.Type != JTokenType.String)
                {
                    throw new InvalidDataException("Invalid casing column mapping.");
                }
                string patch = mapping.Value.Value<string>();
                if (patch != mapping.Name + "__case" || !names.Add(mapping.Name) || !names.Add(patch))
                {
                    throw new InvalidDataException("Invalid or overlapping casing column mapping.");
                }
                columns.Add(mapping.Name, patch);
            }
            if (version == 1)
            {
                return new(columns, []);
            }

            if (descriptor["helpers"] is not JArray helpers)
            {
                throw new InvalidDataException("Missing nested search storage helpers.");
            }

            List<SearchHelper> parsed = [];
            HashSet<string> logical = new(StringComparer.OrdinalIgnoreCase);
            foreach (JToken entry in helpers)
            {
                if (entry is not JObject helper || new[] { "column", "field", "kind", "physical" }.Any(k => helper[k]?.Type != JTokenType.String))
                {
                    throw new InvalidDataException("Invalid nested search helper mapping.");
                }

                string column = helper.Value<string>("column"), field = helper.Value<string>("field"),
                    kind = helper.Value<string>("kind"), physical = helper.Value<string>("physical");
                if (string.IsNullOrWhiteSpace(column) || string.IsNullOrWhiteSpace(field)
                    || kind is not ("list" or "object") || !physical.StartsWith("__quarry_search_", StringComparison.Ordinal)
                    || physical.Length == "__quarry_search_".Length || !names.Add(physical)
                    || !logical.Add(column.Length + ":" + column + field))
                {
                    throw new InvalidDataException("Invalid or overlapping nested search helper mapping.");
                }

                parsed.Add(new(column, field, kind, physical));
            }
            if (parsed.Any(h => parsed.Any(other => h.Physical.Equals(other.Column, StringComparison.OrdinalIgnoreCase))))
            {
                throw new InvalidDataException("Nested search helper overlaps a logical column.");
            }

            bool snapshotMatches = MatchesSnapshot(datasetPath, descriptor["snapshot"] as JObject);
            if (!snapshotMatches && columns.Count > 0)
            {
                throw new InvalidDataException("Quarry storage snapshot changed; casing patches cannot be safely restored. Rebuild this dataset from its original input.");
            }

            bool usable = snapshotMatches && descriptor["search_version"]?.Type == JTokenType.Integer
                && descriptor.Value<long>("search_version") == 1
                && descriptor["stable_row_ids"]?.Type == JTokenType.Boolean
                && descriptor.Value<bool>("stable_row_ids") == false
                && descriptor["helpers_indexed"]?.Type == JTokenType.Boolean && descriptor.Value<bool>("helpers_indexed");
            return new(columns, parsed, snapshotMatches, usable);
        }
        catch (Exception ex) when (ex is not IOException)
        {
            throw new InvalidDataException($"Invalid {path}: {ex.Message}", ex);
        }
    }

    private static bool MatchesSnapshot(string datasetPath, JObject snapshot)
    {
        if (snapshot?["manifest"]?.Type != JTokenType.String || snapshot["sha256"]?.Type != JTokenType.String)
        {
            return false;
        }

        string versions = Path.Combine(datasetPath, "_versions");
        if (!Directory.Exists(versions))
        {
            return false;
        }

        string[] manifests = Directory.EnumerateFiles(versions, "*.manifest", SearchOption.TopDirectoryOnly).Take(2).ToArray();
        if (manifests.Length != 1)
        {
            return false;
        }

        string relative = "_versions/" + Path.GetFileName(manifests[0]);
        if (!relative.Equals(snapshot.Value<string>("manifest"), StringComparison.Ordinal))
        {
            return false;
        }

        using FileStream stream = File.OpenRead(manifests[0]);
        return Convert.ToHexString(SHA256.HashData(stream)).Equals(snapshot.Value<string>("sha256"), StringComparison.OrdinalIgnoreCase);
    }

    public static string Restore(string lower, byte[] patch)
    {
        if (patch is null)
        {
            return lower is null ? null : throw new InvalidDataException("Null casing patch for non-null text.");
        }
        if (lower is null)
        {
            throw new InvalidDataException("Casing patch for null text.");
        }
        if (patch.Length == 0)
        {
            return lower;
        }
        if (patch[0] == (byte)'F')
        {
            return Utf8.GetString(patch, 1, patch.Length - 1);
        }
        byte[] bytes = Utf8.GetBytes(lower);
        void Capitalize(long position)
        {
            if (position < 0 || position >= bytes.Length || bytes[position] is < (byte)'a' or > (byte)'z')
            {
                throw new InvalidDataException("Invalid casing patch offset.");
            }
            bytes[position] -= 32;
        }
        if (patch[0] == (byte)'S')
        {
            long position = 0, gap = 0;
            int shift = 0;
            foreach (byte value in patch.AsSpan(1))
            {
                if (shift >= 35)
                {
                    throw new InvalidDataException("Casing patch varint overflow.");
                }
                gap |= (long)(value & 127) << shift;
                if ((value & 128) != 0)
                {
                    shift += 7;
                }
                else
                {
                    position += gap;
                    Capitalize(position);
                    gap = 0;
                    shift = 0;
                }
            }
            if (shift != 0 || patch.Length == 1)
            {
                throw new InvalidDataException("Truncated casing patch.");
            }
        }
        else if (patch[0] == (byte)'B')
        {
            if (patch.Length != 1 + (bytes.Length + 7L) / 8)
            {
                throw new InvalidDataException("Invalid casing bitmap length.");
            }
            for (int i = 1; i < patch.Length; i++)
            {
                for (int bit = 0; bit < 8; bit++)
                {
                    if ((patch[i] & (1 << bit)) != 0)
                    {
                        Capitalize((i - 1L) * 8 + bit);
                    }
                }
            }
        }
        else
        {
            throw new InvalidDataException("Unknown casing patch format.");
        }
        return Utf8.GetString(bytes);
    }
}
