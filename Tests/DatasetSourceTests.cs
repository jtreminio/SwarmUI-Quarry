using Xunit;

namespace Quarry.Tests;

public class DatasetSourceTests
{
    [Theory]
    [InlineData("/data/x.parquet", "read_parquet('/data/x.parquet')", false)]
    [InlineData("/data/x.csv", "read_csv('/data/x.csv')", false)]
    [InlineData("/data/x.tsv", "read_csv('/data/x.tsv')", false)]
    [InlineData("/data/x.json", "read_json('/data/x.json')", false)]
    [InlineData("/data/x.jsonl", "read_ndjson('/data/x.jsonl')", false)]
    [InlineData("/data/x.ndjson", "read_ndjson('/data/x.ndjson')", false)]
    [InlineData("/data/x.lance", "'/data/x.lance'", true)]
    public void Resolve_MapsExtensionToReader(string path, string expectedFrom, bool requiresLance)
    {
        DatasetSource source = DatasetSource.Resolve(path);
        Assert.Equal(expectedFrom, source.FromExpression);
        Assert.Equal(requiresLance, source.RequiresLance);
    }

    [Fact]
    public void Resolve_IsCaseInsensitive()
    {
        Assert.Equal("read_parquet('/d/X.PARQUET')", DatasetSource.Resolve("/d/X.PARQUET").FromExpression);
    }

    [Fact]
    public void Resolve_EscapesQuoteInPath()
    {
        Assert.Equal("read_csv('/d/o''brien.csv')", DatasetSource.Resolve("/d/o'brien.csv").FromExpression);
    }

    [Fact]
    public void Resolve_UnsupportedType_Throws()
    {
        Assert.Throws<QueryException>(() => DatasetSource.Resolve("/d/notes.txt"));
    }

    [Theory]
    [InlineData("/d/x.parquet", true)]
    [InlineData("/d/x.lance", true)]
    [InlineData("/d/x.CSV", true)]
    [InlineData("/d/x.txt", false)]
    [InlineData("/d/x", false)]
    public void IsSupported_ChecksExtension(string path, bool expected)
    {
        Assert.Equal(expected, DatasetSource.IsSupported(path));
    }
}
