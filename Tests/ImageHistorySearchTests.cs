using Xunit;

namespace Quarry.Tests;

public class ImageHistorySearchTests
{
    [Theory]
    [InlineData("date", "mtime")]   // friendly alias
    [InlineData("name", "path")]    // friendly alias
    [InlineData("", "mtime")]       // default
    [InlineData(null, "mtime")]     // default
    [InlineData("bogus-column", "mtime")] // not allow-listed -> default (this is the ORDER BY injection guard)
    [InlineData("steps", "steps")]  // a real result column passes through
    [InlineData("PATH", "path")]    // allow-list is case-insensitive
    public void ResolveSort_MapsAliasesAndAllowlistsColumns(string input, string expected)
    {
        Assert.Equal(expected, ImageHistorySearch.ResolveSort(input));
    }
}
