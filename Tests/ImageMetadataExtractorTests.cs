using Xunit;

namespace Quarry.Tests;

public class ImageMetadataExtractorTests
{
    private static ImageHistoryFile File(string relative) => new(relative, $"/abs/{relative}", 123L, "10:123");

    [Fact]
    public void BuildRow_NoMetadata_KeepsPathAndStarred()
    {
        ImageIndexRow row = ImageMetadataExtractor.BuildRow(File("Starred/a.png"), null, 5);
        Assert.Equal("Starred/a.png", row.Path);
        Assert.Equal("10:123", row.FileHash);
        Assert.Equal(5, row.IndexedAt);
        Assert.True(row.IsStarred);
        Assert.Null(row.FullMetadata);
        Assert.Equal("{}", row.MetaJson);
    }

    [Fact]
    public void BuildRow_ExtractsCoreFields()
    {
        string meta = """
        {"sui_image_params":{"prompt":"a cat","negativeprompt":"blur","model":"sdxl","seed":42,"steps":20,"cfgscale":7.5,"sampler":"euler","width":1024,"height":768,"loras":["lora1","lora2"],"scheduler":"karras"},"sui_extra_data":{"original_prompt":"a <q:cats>","used_embeddings":["emb1"]}}
        """;
        ImageIndexRow row = ImageMetadataExtractor.BuildRow(File("raw/2026/a.png"), meta, 9);
        Assert.Equal("a cat", row.Prompt);
        Assert.Equal("blur", row.NegativePrompt);
        Assert.Equal("sdxl", row.Model);
        Assert.Equal(42L, row.Seed!.Value);
        Assert.Equal(20L, row.Steps!.Value);
        Assert.Equal(7.5, row.CfgScale!.Value);
        Assert.Equal("euler", row.Sampler);
        Assert.Equal(1024L, row.Width!.Value);
        Assert.Equal(768L, row.Height!.Value);
        Assert.Equal("lora1, lora2", row.Loras); // flat, comma-separated scalar -- never a list column
        Assert.Equal("emb1", row.Embeddings);
        Assert.Equal("a <q:cats>", row.OriginalPrompt);
        Assert.False(row.IsStarred);
        Assert.Equal(meta, row.FullMetadata);
        // scheduler is not a promoted column -> it lands in the discovered-fields catch-all
        Assert.Contains("scheduler", row.MetaJson);
        Assert.Contains("karras", row.MetaJson);
        // promoted keys must not be duplicated into meta_json
        Assert.DoesNotContain("\"prompt\"", row.MetaJson);
        Assert.DoesNotContain("\"loras\"", row.MetaJson);
    }

    [Fact]
    public void BuildRow_MultiValueParams_AreCommaSeparatedText_EmptyBecomesNull()
    {
        // loras/embeddings are stored flat (comma-separated), and an empty list collapses to NULL -- never a "[]"
        // list column, which would overflow Lance's mini-block rep/def buffer on a large history.
        ImageIndexRow row = ImageMetadataExtractor.BuildRow(
            File("a.png"), """{"sui_image_params":{"loras":["x","y","z"]},"sui_extra_data":{"used_embeddings":[]}}""", 1);
        Assert.Equal("x, y, z", row.Loras);
        Assert.Null(row.Embeddings);
    }

    [Fact]
    public void BuildRow_OriginalPromptFallsBackToPrompt()
    {
        ImageIndexRow row = ImageMetadataExtractor.BuildRow(File("a.png"), """{"sui_image_params":{"prompt":"hello"}}""", 1);
        Assert.Equal("hello", row.OriginalPrompt);
    }

    [Fact]
    public void BuildRow_StringNumbersParsed()
    {
        ImageIndexRow row = ImageMetadataExtractor.BuildRow(File("a.png"), """{"sui_image_params":{"steps":"30","cfgscale":"6","seed":"-1"}}""", 1);
        Assert.Equal(30L, row.Steps!.Value);
        Assert.Equal(6.0, row.CfgScale!.Value);
        Assert.Equal(-1L, row.Seed!.Value);
    }

    [Fact]
    public void BuildRow_IsStarredFromMetadataFlag()
    {
        ImageIndexRow row = ImageMetadataExtractor.BuildRow(File("raw/a.png"), """{"is_starred":true,"sui_image_params":{"prompt":"x"}}""", 1);
        Assert.True(row.IsStarred);
    }

    [Fact]
    public void BuildRow_InvalidJson_KeepsRawButNoFields()
    {
        ImageIndexRow row = ImageMetadataExtractor.BuildRow(File("a.png"), "not json", 1);
        Assert.Equal("not json", row.FullMetadata);
        Assert.Null(row.Prompt);
        Assert.Equal("{}", row.MetaJson);
    }
}
