using System.Globalization;
using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SwarmUI.Media;
using SwarmUI.Utils;

namespace Quarry;

public sealed class ImageIndexRow
{
    public string FileHash;
    public string Path;
    public long Mtime;
    public bool IsStarred;
    public long IndexedAt;
    public string Prompt;
    public string NegativePrompt;
    public string OriginalPrompt;
    public string Model;
    public long? Seed;
    public long? Steps;
    public double? CfgScale;
    public string Sampler;
    public long? Width;
    public long? Height;
    public string Loras;
    public string Embeddings;
    public string MetaJson = "{}";
    public string FullMetadata;

    public JObject ToJson() => new()
    {
        ["file_hash"] = FileHash,
        ["path"] = Path,
        ["mtime"] = Mtime,
        ["is_starred"] = IsStarred,
        ["indexed_at"] = IndexedAt,
        ["prompt"] = Str(Prompt),
        ["negativeprompt"] = Str(NegativePrompt),
        ["original_prompt"] = Str(OriginalPrompt),
        ["model"] = Str(Model),
        ["seed"] = Num(Seed),
        ["steps"] = Num(Steps),
        ["cfgscale"] = Num(CfgScale),
        ["sampler"] = Str(Sampler),
        ["width"] = Num(Width),
        ["height"] = Num(Height),
        ["loras"] = Str(Loras),
        ["embeddings"] = Str(Embeddings),
        ["meta_json"] = MetaJson ?? "{}",
        ["full_metadata"] = Str(FullMetadata),
    };

    private static JToken Str(string value) => value is null ? JValue.CreateNull() : new JValue(value);
    private static JToken Num(long? value) => value.HasValue ? new JValue(value.Value) : JValue.CreateNull();
    private static JToken Num(double? value) => value.HasValue ? new JValue(value.Value) : JValue.CreateNull();
}

public static class ImageMetadataExtractor
{
    private static readonly HashSet<string> SedExcluded = new(StringComparer.OrdinalIgnoreCase)
    {
        "original_prompt", "used_embeddings", "unused_parameters", "loras",
    };

    public static ImageIndexRow Extract(ImageHistoryFile file, string root, bool starNoFolders, long indexedAt)
    {
        string raw = null;
        try
        {
            raw = OutputMetadataTracker.GetMetadataFor(file.AbsolutePath, root, starNoFolders)?.Metadata;
        }
        catch (Exception ex)
        {
            Logs.Debug($"Quarry: could not read metadata for '{file.RelativePath}': {ex.Message}");
        }
        if (!HasGenParams(raw))
        {
            string embedded = TryReadEmbeddedMetadata(file.AbsolutePath);
            if (!string.IsNullOrWhiteSpace(embedded))
            {
                raw = embedded;
            }
        }
        return BuildRow(file, raw, indexedAt);
    }

    private static bool HasGenParams(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return false;
        }
        try
        {
            return JObject.Parse(raw)["sui_image_params"] is JObject;
        }
        catch
        {
            return false;
        }
    }

    private static string TryReadEmbeddedMetadata(string absolutePath)
    {
        try
        {
            string ext = Path.GetExtension(absolutePath).TrimStart('.').ToLowerInvariant();
            if (OutputMetadataTracker.ExtensionsWithMetadata.Contains(ext))
            {
                return null;
            }
            MediaType type = MediaType.GetByExtension(ext);
            if (type is null || (type.MetaType != MediaMetaType.Image && type.MetaType != MediaMetaType.Animation))
            {
                return null;
            }
            byte[] bytes = File.ReadAllBytes(absolutePath);
            return bytes.Length == 0 ? null : new Image(bytes, type).GetMetadata();
        }
        catch (Exception ex)
        {
            Logs.Debug($"Quarry: direct embedded-metadata read failed for '{absolutePath}': {ex.Message}");
            return null;
        }
    }

    public static ImageIndexRow BuildRow(ImageHistoryFile file, string rawMetadata, long indexedAt)
    {
        ImageIndexRow row = new()
        {
            FileHash = file.Hash,
            Path = file.RelativePath,
            Mtime = file.MtimeTicks,
            IndexedAt = indexedAt,
            IsStarred = file.RelativePath.StartsWith("Starred/", StringComparison.OrdinalIgnoreCase),
        };
        if (string.IsNullOrWhiteSpace(rawMetadata))
        {
            return row;
        }
        string raw = rawMetadata;
        row.FullMetadata = raw;
        JObject full;
        try
        {
            full = JObject.Parse(raw);
        }
        catch
        {
            return row;
        }
        if (full["is_starred"]?.Type == JTokenType.Boolean && full.Value<bool>("is_starred"))
        {
            row.IsStarred = true;
        }
        JObject sip = full["sui_image_params"] as JObject;
        JObject sed = full["sui_extra_data"] as JObject;
        if (sip is not null)
        {
            row.Prompt = sip.Value<string>("prompt");
            row.NegativePrompt = sip.Value<string>("negativeprompt");
            row.Model = sip.Value<string>("model");
            row.Sampler = sip.Value<string>("sampler");
            row.Seed = AsLong(sip["seed"]);
            row.Steps = AsLong(sip["steps"]);
            row.CfgScale = AsDouble(sip["cfgscale"]);
            row.Width = AsLong(sip["width"]);
            row.Height = AsLong(sip["height"]);
            row.Loras = AsCsv(sip["loras"]);
        }
        if (sed is not null)
        {
            row.OriginalPrompt = sed.Value<string>("original_prompt");
            row.Embeddings = AsCsv(sed["used_embeddings"]);
        }
        row.OriginalPrompt ??= row.Prompt;
        row.MetaJson = BuildMetaJson(sip, sed);
        return row;
    }

    private static string BuildMetaJson(JObject sip, JObject sed)
    {
        JObject meta = [];
        if (sip is not null)
        {
            foreach (JProperty property in sip.Properties())
            {
                if (!ImageHistoryIndex.PromotedParamKeys.Contains(property.Name))
                {
                    meta[property.Name] = property.Value.DeepClone();
                }
            }
        }
        if (sed is not null)
        {
            foreach (JProperty property in sed.Properties())
            {
                if (!SedExcluded.Contains(property.Name) && meta[property.Name] is null)
                {
                    meta[property.Name] = property.Value.DeepClone();
                }
            }
        }
        return meta.ToString(Formatting.None);
    }

    private static long? AsLong(JToken token) => token?.Type switch
    {
        JTokenType.Integer => token.Value<long>(),
        JTokenType.Float => (long)token.Value<double>(),
        JTokenType.String when long.TryParse(token.Value<string>(), NumberStyles.Integer, CultureInfo.InvariantCulture, out long parsed) => parsed,
        _ => null,
    };

    private static double? AsDouble(JToken token) => token?.Type switch
    {
        JTokenType.Integer or JTokenType.Float => token.Value<double>(),
        JTokenType.String when double.TryParse(token.Value<string>(), NumberStyles.Float, CultureInfo.InvariantCulture, out double parsed) => parsed,
        _ => null,
    };

    private static string AsCsv(JToken token)
    {
        List<string> result = [];
        if (token is JArray array)
        {
            foreach (JToken element in array)
            {
                if (element.Type == JTokenType.Null)
                {
                    continue;
                }
                string text = element.ToString();
                if (text.Length > 0)
                {
                    result.Add(text);
                }
            }
        }
        else if (token is not null && token.Type == JTokenType.String)
        {
            string value = token.Value<string>();
            if (!string.IsNullOrEmpty(value))
            {
                result.Add(value);
            }
        }
        return result.Count == 0 ? null : string.Join(", ", result);
    }
}
