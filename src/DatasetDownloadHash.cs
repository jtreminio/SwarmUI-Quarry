using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Quarry;

internal static class DatasetDownloadHash
{
    internal static string Parse(string json)
    {
        JToken value = JObject.Parse(json)["datasetHash"];
        string hash = value?.Type == JTokenType.String ? (string)value : null;
        return hash is { Length: 64 } && hash.All(Uri.IsHexDigit) ? hash.ToLowerInvariant() : null;
    }

    internal static bool HasUpdate(string directory, string remoteHash)
    {
        if (remoteHash is null)
        {
            return false;
        }
        string localHash = null;
        try
        {
            localHash = Parse(File.ReadAllText(Path.Combine(directory, CasingStorage.DescriptorName)));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
        }
        return !string.Equals(localHash, remoteHash, StringComparison.OrdinalIgnoreCase);
    }
}
