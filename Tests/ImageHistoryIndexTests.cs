using Xunit;

namespace Quarry.Tests;

public class ImageHistoryIndexTests
{
    [Fact]
    public void CoreFields_AreTheCuratedThirteen()
    {
        Assert.Equal(13, ImageHistoryIndex.CoreFields.Count);
        Assert.Equal("prompt", ImageHistoryIndex.CoreFields[0].Column);
        Assert.Equal("is_starred", ImageHistoryIndex.CoreFields[^1].Column);
        Assert.Contains(ImageHistoryIndex.CoreFields, f => f is { Column: "loras", Type: ImageFieldType.List });
        Assert.Contains(ImageHistoryIndex.CoreFields, f => f is { Column: "cfgscale", Type: ImageFieldType.Number });
    }

    [Fact]
    public void CreateTableSql_HasListAndJsonColumns()
    {
        string sql = ImageHistoryIndex.CreateTableSql("q.main.idx");
        Assert.StartsWith("CREATE TABLE q.main.idx (", sql);
        Assert.Contains("loras VARCHAR[]", sql);
        Assert.Contains("embeddings VARCHAR[]", sql);
        Assert.Contains("meta_json VARCHAR", sql);
        Assert.Contains("full_metadata VARCHAR", sql);
    }

    [Fact]
    public void MergeUpsertSql_KeysOnPathAndStagesViaReadJson()
    {
        string sql = ImageHistoryIndex.MergeUpsertSql("t", "'/tmp/s.json'");
        Assert.Contains("ON t.path = s.path", sql);
        Assert.Contains("WHEN MATCHED THEN UPDATE SET", sql);
        Assert.Contains("WHEN NOT MATCHED THEN INSERT", sql);
        Assert.Contains("read_json('/tmp/s.json', format='array', columns=", sql);
        // path is the merge key, never part of the UPDATE SET list
        Assert.DoesNotContain("path = s.path,", sql);
    }

    [Fact]
    public void MergePruneSql_DeletesRowsNotInSource()
    {
        string sql = ImageHistoryIndex.MergePruneSql("t", "'/tmp/p.json'");
        Assert.Contains("WHEN NOT MATCHED BY SOURCE THEN DELETE", sql);
        Assert.Contains("columns={path: 'VARCHAR'}", sql);
        Assert.DoesNotContain("WHEN MATCHED", sql);
    }

    [Fact]
    public void ResultColumns_ExcludeMetaJson()
    {
        Assert.DoesNotContain("meta_json", ImageHistoryIndex.ResultColumns);
        Assert.Contains("path", ImageHistoryIndex.ResultColumns);
        Assert.Contains("full_metadata", ImageHistoryIndex.ResultColumns);
    }

    [Theory]
    [InlineData("alice", "alice")]
    [InlineData("user.1-x", "user.1-x")]
    [InlineData("", "_")]
    public void SafeUserSegment_KeepsAlreadySafeIdsVerbatim(string input, string expected)
    {
        Assert.Equal(expected, ImageHistoryIndex.SafeUserSegment(input));
    }

    [Fact]
    public void SafeUserSegment_SanitizesUnsafeCharsAndDisambiguatesCollisions()
    {
        // Unsafe chars collapse to '_'; a hash suffix then keeps two ids that would otherwise collide distinct, so
        // two users never share one private index dir.
        Assert.StartsWith("a_b_c-", ImageHistoryIndex.SafeUserSegment("a/b\\c"));
        Assert.Equal("a_b", ImageHistoryIndex.SafeUserSegment("a_b")); // already safe -> plain name
        Assert.StartsWith("a_b-", ImageHistoryIndex.SafeUserSegment("a/b")); // sanitized -> disambiguated
        Assert.NotEqual(ImageHistoryIndex.SafeUserSegment("a/b"), ImageHistoryIndex.SafeUserSegment("a_b"));
    }
}
