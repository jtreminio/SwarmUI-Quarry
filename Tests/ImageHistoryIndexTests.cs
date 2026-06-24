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
        Assert.Contains(ImageHistoryIndex.CoreFields, f => f is { Column: "loras", Type: ImageFieldType.Text });
        Assert.Contains(ImageHistoryIndex.CoreFields, f => f is { Column: "cfgscale", Type: ImageFieldType.Number });
    }

    [Fact]
    public void CreateTableSql_DeclaresFlatScalarColumns_NeverLists()
    {
        string sql = ImageHistoryIndex.CreateTableSql("q.main.idx");
        Assert.StartsWith("CREATE TABLE q.main.idx (", sql);
        // loras/embeddings are flat VARCHAR, not list columns -- list columns overflow Lance's mini-block rep/def
        // buffer when empty across a large, clustered history, breaking every write to the index.
        Assert.Contains("loras VARCHAR", sql);
        Assert.Contains("embeddings VARCHAR", sql);
        Assert.DoesNotContain("VARCHAR[]", sql);
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

    [Fact]
    public void CreateTableSql_AddsLowercaseCompanionColumns()
    {
        string sql = ImageHistoryIndex.CreateTableSql("q.main.idx");
        Assert.Contains("prompt__lc VARCHAR", sql);
        Assert.Contains("sampler__lc VARCHAR", sql);
    }

    [Fact]
    public void MergeUpsertSql_ComputesAndWritesLowercaseCompanions()
    {
        string sql = ImageHistoryIndex.MergeUpsertSql("t", "'/tmp/s.json'");
        Assert.Contains("lower(prompt) AS prompt__lc", sql); // computed in the staged source
        Assert.Contains("prompt__lc = s.prompt__lc", sql);   // populated on UPDATE
        Assert.Contains("s.prompt__lc", sql);                // populated on INSERT
    }

    [Fact]
    public void LowercaseCompanions_CoverTheMultiValueTextColumns()
    {
        // loras/embeddings are flat text now, so they get the same lowercased NGRAM companion as the other text
        // columns -- substring search on them is index-accelerated on a large history, not a full lower() scan.
        Assert.Contains("loras", ImageHistoryIndex.LowercaseSearchColumns);
        Assert.Contains("embeddings", ImageHistoryIndex.LowercaseSearchColumns);
        string create = ImageHistoryIndex.CreateTableSql("q.main.idx");
        Assert.Contains("loras__lc VARCHAR", create);
        Assert.Contains("embeddings__lc VARCHAR", create);
        List<(string Drop, string Create)> ddls = [.. ImageHistoryIndex.NgramIndexDdls("t")];
        Assert.Contains(ddls, d => d.Create == "CREATE INDEX loras__lc_idx ON t (loras__lc) USING NGRAM;");
        Assert.Contains(ddls, d => d.Create == "CREATE INDEX embeddings__lc_idx ON t (embeddings__lc) USING NGRAM;");
    }

    [Fact]
    public void ResultColumns_ExcludeLowercaseCompanions()
    {
        // Companions are internal search columns; they must never leak into browser result rows.
        Assert.DoesNotContain("prompt__lc", ImageHistoryIndex.ResultColumns);
    }

    [Fact]
    public void NgramIndexDdls_DropAndCreateNgramOnEachCompanion()
    {
        List<(string Drop, string Create)> ddls = [.. ImageHistoryIndex.NgramIndexDdls("t")];
        Assert.Equal(ImageHistoryIndex.LowercaseSearchColumns.Count, ddls.Count);
        Assert.Contains(ddls, d => d.Create == "CREATE INDEX prompt__lc_idx ON t (prompt__lc) USING NGRAM;");
        Assert.Contains(ddls, d => d.Drop == "DROP INDEX prompt__lc_idx ON t;");
    }

    [Fact]
    public void BtreeIndexColumns_AreTheDeclaredNumericColumns()
    {
        Assert.Equal(
            new[] { "mtime", "indexed_at", "seed", "steps", "cfgscale", "width", "height" },
            ImageHistoryIndex.BtreeIndexColumns);
        // never BTREE the bool, the merge key, or text columns
        Assert.DoesNotContain("is_starred", ImageHistoryIndex.BtreeIndexColumns);
        Assert.DoesNotContain("path", ImageHistoryIndex.BtreeIndexColumns);
        Assert.DoesNotContain("file_hash", ImageHistoryIndex.BtreeIndexColumns);
        Assert.DoesNotContain("prompt", ImageHistoryIndex.BtreeIndexColumns);
    }

    [Fact]
    public void BtreeIndexDdls_DropAndCreateBtreeOnEachNumericColumn()
    {
        List<(string Drop, string Create)> ddls = [.. ImageHistoryIndex.BtreeIndexDdls("t")];
        Assert.Equal(ImageHistoryIndex.BtreeIndexColumns.Count, ddls.Count);
        Assert.Contains(ddls, d => d.Create == "CREATE INDEX seed_idx ON t (seed) USING BTREE;");
        Assert.Contains(ddls, d => d.Drop == "DROP INDEX seed_idx ON t;");
        Assert.Contains(ddls, d => d.Create == "CREATE INDEX cfgscale_idx ON t (cfgscale) USING BTREE;");
        // BTREE DDLs must never target the lowercase NGRAM companions
        Assert.DoesNotContain(ddls, d => d.Create.Contains("__lc"));
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
