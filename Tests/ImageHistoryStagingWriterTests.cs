using System.IO;
using System.Text.Json;
using Xunit;

namespace Quarry.Tests;

// The scanner streams staging/prune files row-by-row instead of building one giant in-memory string (which OOMs on
// large libraries). These tests pin the on-disk contract the MERGE/prune SQL reads back via
// read_json(format='array', ...): a well-formed JSON array, correctly escaped, with the expected per-row shape.
public class ImageHistoryStagingWriterTests
{
    private sealed class TempFile : IDisposable
    {
        public string Path { get; } =
            System.IO.Path.Combine(System.IO.Path.GetTempPath(), "quarry-staging-" + Guid.NewGuid().ToString("N") + ".json");

        public void Dispose()
        {
            try
            {
                File.Delete(Path);
            }
            catch (IOException)
            {
            }
        }
    }

    [Fact]
    public void WriteRowsJson_EmitsValidArray_WithShapeNullsScalarsAndEscaping()
    {
        // A prompt full of JSON-hostile characters proves the streamed output is escaped exactly as the old
        // JArray.ToString() did; a null column and a populated multi-value column (now flat, comma-separated text)
        // pin the rest of the read_json shape.
        const string trickyPrompt = "a \"quoted\" value, a \\ backslash,\na newline, tab\t, unicode ✓";
        ImageIndexRow row = new()
        {
            FileHash = "12:34",
            Path = "Starred/sub/img one.png",
            Mtime = 100,
            IsStarred = true,
            IndexedAt = 200,
            Prompt = trickyPrompt,
            NegativePrompt = null,
            Model = "some-model",
            Seed = 42,
            CfgScale = 7.5,
            Loras = "lora_a, lora_b",
            Embeddings = null,
        };

        using TempFile file = new();
        ImageHistoryScanner.WriteRowsJson(file.Path, [row]);

        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(file.Path));
        Assert.Equal(JsonValueKind.Array, doc.RootElement.ValueKind);
        Assert.Equal(1, doc.RootElement.GetArrayLength());

        JsonElement only = doc.RootElement[0];
        Assert.Equal("Starred/sub/img one.png", only.GetProperty("path").GetString());
        Assert.Equal(trickyPrompt, only.GetProperty("prompt").GetString()); // round-trips byte-for-byte: escaping intact
        Assert.True(only.GetProperty("is_starred").GetBoolean());
        Assert.Equal(42, only.GetProperty("seed").GetInt64());
        Assert.Equal(7.5, only.GetProperty("cfgscale").GetDouble());
        Assert.Equal(JsonValueKind.Null, only.GetProperty("negativeprompt").ValueKind);
        Assert.Equal("lora_a, lora_b", only.GetProperty("loras").GetString()); // flat scalar text, not a JSON array
        Assert.Equal(JsonValueKind.Null, only.GetProperty("embeddings").ValueKind); // absent multi-value -> JSON null
    }

    [Fact]
    public void WriteRowsJson_EmptyList_EmitsEmptyArray()
    {
        using TempFile file = new();
        ImageHistoryScanner.WriteRowsJson(file.Path, []);

        Assert.Equal("[]", File.ReadAllText(file.Path).Trim());
    }

    [Fact]
    public void WritePathsJson_EmitsPathObjects_WithEscaping()
    {
        ImageHistoryFile a = new("plain/a.png", "/abs/plain/a.png", 1, "h1");
        ImageHistoryFile b = new("odd/\"quote\"\\slash.png", "/abs/odd.png", 2, "h2");

        using TempFile file = new();
        ImageHistoryScanner.WritePathsJson(file.Path, [a, b]);

        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(file.Path));
        Assert.Equal(JsonValueKind.Array, doc.RootElement.ValueKind);
        Assert.Equal(2, doc.RootElement.GetArrayLength());
        Assert.Equal("plain/a.png", doc.RootElement[0].GetProperty("path").GetString());
        Assert.Equal("odd/\"quote\"\\slash.png", doc.RootElement[1].GetProperty("path").GetString());
    }

    [Fact]
    public void WritePathsJson_EmptyList_EmitsEmptyArray()
    {
        using TempFile file = new();
        ImageHistoryScanner.WritePathsJson(file.Path, []);

        Assert.Equal("[]", File.ReadAllText(file.Path).Trim());
    }
}
