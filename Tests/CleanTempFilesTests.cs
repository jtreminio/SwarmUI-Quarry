using Xunit;

namespace Quarry.Tests;

// Covers the sentinel-matching that CleanTempFiles uses to decide which Wildcards .txt files are leftover
// Quarry placeholders (deletable) versus real user wildcards (must be left alone).
public class CleanTempFilesTests
{
    [Theory]
    [InlineData("# Quarry placeholder - do not edit\n")]
    [InlineData("# Quarry placeholder - do not edit")]
    [InlineData("# DuckDb Wildcards placeholder - do not edit")]
    [InlineData("   # Quarry placeholder - do not edit   ")]
    [InlineData("# QUARRY PLACEHOLDER - DO NOT EDIT")]
    public void RecognizesPlaceholderSentinels(string content)
    {
        Assert.True(DatasetManager.IsLegacyPlaceholder(content));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("red\ngreen\nblue")] // a real wildcard: a list of values
    [InlineData("# do not edit")] // missing "placeholder"
    [InlineData("# just a placeholder comment")] // missing "do not edit"
    [InlineData("placeholder - do not edit")] // not a comment line
    [InlineData("# Quarry placeholder - do not edit\nred\ngreen")] // sentinel-looking first line, but real content follows
    [InlineData("# Quarry placeholder - do not edit whattheduck")] // sentinel words but contains "whattheduck"
    [InlineData("# WhatTheDuck placeholder - do not edit")] // "whattheduck" is matched case-insensitively
    [InlineData("# WhatTheDuck datadump placeholder - do not edit")] // the real WhatTheDuck datadump placeholder
    public void RejectsRealWildcardsAndNonSentinels(string content)
    {
        Assert.False(DatasetManager.IsLegacyPlaceholder(content));
    }
}
