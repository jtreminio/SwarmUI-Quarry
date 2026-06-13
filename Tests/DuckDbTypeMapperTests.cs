using Xunit;

namespace Quarry.Tests;

public class DuckDbTypeMapperTests
{
    [Theory]
    [InlineData("VARCHAR")]
    [InlineData("INTEGER")]
    [InlineData("BIGINT")]
    [InlineData("DOUBLE")]
    [InlineData("BOOLEAN")]
    [InlineData("DECIMAL(10,2)")]
    [InlineData("MAP(VARCHAR, INTEGER)")]
    [InlineData("STRUCT(a INTEGER)")]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void ScalarTypes(string type)
    {
        Assert.Equal(ColumnKind.Scalar, DuckDbTypeMapper.MapKind(type));
    }

    [Theory]
    [InlineData("VARCHAR[]")]
    [InlineData("INTEGER[3]")]
    [InlineData("VARCHAR[][]")]
    [InlineData("LIST(VARCHAR)")]
    [InlineData("ARRAY(INTEGER)")]
    [InlineData("list(varchar)")]
    [InlineData("varchar[]")]
    public void ListTypes(string type)
    {
        Assert.Equal(ColumnKind.List, DuckDbTypeMapper.MapKind(type));
    }
}
