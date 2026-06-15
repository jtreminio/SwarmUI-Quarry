using Xunit;

namespace Quarry.Tests;

public class DatasetNamingTests
{
    [Theory]
    [InlineData("prompts/1girl.parquet", "prompts/1girl")]
    [InlineData("prompts\\1girl.parquet", "prompts/1girl")]
    [InlineData("1girl.csv", "1girl")]
    [InlineData("/lead/slash.jsonl", "lead/slash")]
    [InlineData("styles.v2/list.jsonl", "styles.v2/list")]
    [InlineData("data.lance", "data")]
    [InlineData("noext", "noext")]
    public void ToName_StripsFinalExtensionAndNormalizes(string relative, string expected)
    {
        Assert.Equal(expected, DatasetNaming.ToName(relative));
    }
}
