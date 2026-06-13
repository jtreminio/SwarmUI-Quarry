using Xunit;

namespace Quarry.Tests;

public class WildcardNamingTests
{
    [Theory]
    [InlineData("prompts/1girl.parquet", "prompts/1girl")]
    [InlineData("prompts\\1girl.parquet", "prompts/1girl")]
    [InlineData("1girl.csv", "1girl")]
    [InlineData("/lead/slash.jsonl", "lead/slash")]
    [InlineData("styles.v2/list.jsonl", "styles.v2/list")]
    [InlineData("data.lance", "data")]
    [InlineData("noext", "noext")]
    public void ToWildcardName_StripsFinalExtensionAndNormalizes(string relative, string expected)
    {
        Assert.Equal(expected, WildcardNaming.ToWildcardName(relative));
    }

    [Fact]
    public void ToPlaceholderRelativePath_AppendsTxt()
    {
        Assert.Equal("prompts/1girl.txt", WildcardNaming.ToPlaceholderRelativePath("prompts/1girl"));
    }
}
