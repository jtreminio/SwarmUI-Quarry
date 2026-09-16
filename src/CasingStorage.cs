using System.IO;
using Newtonsoft.Json.Linq;

namespace Quarry;

/// <summary>Quarry storage v1.</summary>
internal static class CasingStorage
{
    public const string DescriptorName = "quarry-storage.json";
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static Dictionary<string, string> Load(string datasetPath)
    {
        Dictionary<string, string> columns = new(StringComparer.OrdinalIgnoreCase);
        string path = Path.Combine(datasetPath, DescriptorName);
        if (!File.Exists(path))
        {
            return columns;
        }
        try
        {
            JObject descriptor = JObject.Parse(File.ReadAllText(path));
            if (descriptor.Value<int?>("version") != 1 || descriptor["columns"] is not JObject mappings)
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
            return columns;
        }
        catch (Exception ex) when (ex is not IOException)
        {
            throw new InvalidDataException($"Invalid {path}: {ex.Message}", ex);
        }
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
