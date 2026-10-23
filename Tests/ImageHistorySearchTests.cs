using DuckDB.NET.Data;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Quarry.Tests;

public class ImageHistorySearchTests
{
    [Theory]
    [InlineData("raw")]
    [InlineData("a'b_%")]
    public void DirectoryLimit_MatchesOnlyDescendantsAndCombinesWithOtherFilters(string directory)
    {
        using DuckDBConnection connection = new("Data Source=:memory:");
        connection.Open();
        using var command = connection.CreateCommand();
        SqlFilter filter = ImageSearchFilterBuilder.Build(JArray.Parse("""[{"field":"prompt","op":"=","value":"cat"}]"""));
        filter = ImageHistorySearch.LimitToDirectories(filter, [directory, "Starred"]);
        command.CommandText = $"""
            SELECT path FROM (VALUES
                ($folder || '/a.png', 'cat'),
                ($folder || '/nested/b.png', 'cat'),
                ($folder || '-other/c.png', 'cat'),
                ('other/' || $folder || '/d.png', 'cat'),
                ($folder || '/e.png', 'dog'),
                ('Starred/a.png', 'cat'),
                ('Starred/b.png', 'dog')
            ) AS images(path, prompt) WHERE {filter.WhereClause} ORDER BY path;
            """;
        command.Parameters.Add(new DuckDBParameter("folder", directory));
        foreach (QueryParameter parameter in filter.Parameters)
        {
            command.Parameters.Add(new DuckDBParameter(parameter.Name, parameter.Value));
        }
        using var reader = command.ExecuteReader();
        List<string> paths = [];
        while (reader.Read())
        {
            paths.Add(reader.GetString(0));
        }
        Assert.Equal(new[] { "Starred/a.png", directory + "/a.png", directory + "/nested/b.png" }.Order(StringComparer.Ordinal), paths);
    }

    [Fact]
    public void DirectoryLimit_BlankPreservesFilterAndDirectoryAloneRestrictsSearch()
    {
        SqlFilter filter = ImageSearchFilterBuilder.Build(JArray.Parse("""[{"field":"prompt","op":"=","value":"cat"}]"""));
        Assert.Same(filter, ImageHistorySearch.LimitToDirectories(filter, [""]));
        Assert.Same(SqlFilter.None, ImageHistorySearch.LimitToDirectories(SqlFilter.None, [""]));
        SqlFilter restricted = ImageHistorySearch.LimitToDirectories(SqlFilter.None, ["raw"]);
        Assert.False(restricted.IsEmpty);
        Assert.Equal("raw/", Assert.Single(restricted.Parameters).Value);
        Assert.Equal("FALSE", ImageHistorySearch.LimitToDirectories(SqlFilter.None, []).WhereClause);
    }

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
