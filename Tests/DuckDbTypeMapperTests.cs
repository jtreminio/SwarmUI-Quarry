using Xunit;

namespace Quarry.Tests;

public class DuckDbTypeMapperTests
{
    [Theory]
    [InlineData("STRUCT(a INTEGER)")]
    [InlineData("struct(hair VARCHAR, eyes VARCHAR)")]
    public void ObjectTypes(string type) => Assert.Equal(ColumnKind.Object, DuckDbTypeMapper.MapKind(type));

    [Theory]
    [InlineData("VARCHAR")]
    [InlineData("INTEGER")]
    [InlineData("BIGINT")]
    [InlineData("DOUBLE")]
    [InlineData("BOOLEAN")]
    [InlineData("DECIMAL(10,2)")]
    [InlineData("MAP(VARCHAR, INTEGER)")]
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

    [Theory]
    [InlineData("TINYINT")]
    [InlineData("SMALLINT")]
    [InlineData("INTEGER")]
    [InlineData("BIGINT")]
    [InlineData("HUGEINT")]
    [InlineData("UTINYINT")]
    [InlineData("UBIGINT")]
    [InlineData("FLOAT")]
    [InlineData("DOUBLE")]
    [InlineData("REAL")]
    [InlineData("DECIMAL(10,2)")]
    [InlineData("DECIMAL(18, 3)")]
    [InlineData("NUMERIC")]
    [InlineData("integer")]
    [InlineData("  BIGINT  ")]
    public void NumericTypes(string type)
    {
        Assert.True(DuckDbTypeMapper.IsNumeric(type));
    }

    [Theory]
    [InlineData("VARCHAR")]
    [InlineData("BOOLEAN")]
    [InlineData("DATE")]
    [InlineData("TIMESTAMP")]
    [InlineData("BLOB")]
    [InlineData("UUID")]
    [InlineData("MAP(VARCHAR, INTEGER)")]
    [InlineData("INTEGER[]")] // a list of numbers is not a numeric scalar
    [InlineData("DECIMAL[]")]
    [InlineData("ARRAY(DOUBLE)")]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void NonNumericTypes(string type)
    {
        Assert.False(DuckDbTypeMapper.IsNumeric(type));
    }

    [Theory]
    [InlineData("TINYINT")]
    [InlineData("SMALLINT")]
    [InlineData("INTEGER")]
    [InlineData("BIGINT")]
    [InlineData("HUGEINT")]
    [InlineData("UTINYINT")]
    [InlineData("UBIGINT")]
    [InlineData("integer")]
    [InlineData("  BIGINT  ")]
    public void IntegerTypes(string type)
    {
        Assert.True(DuckDbTypeMapper.IsIntegerType(type));
    }

    [Theory]
    [InlineData("FLOAT")]   // floats keep fractions, so they are not "integer" for bound rounding
    [InlineData("DOUBLE")]
    [InlineData("REAL")]
    [InlineData("DECIMAL(10,2)")]
    [InlineData("NUMERIC")]
    [InlineData("VARCHAR")]
    [InlineData("INTEGER[]")]
    [InlineData("")]
    [InlineData(null)]
    public void NonIntegerTypes(string type)
    {
        Assert.False(DuckDbTypeMapper.IsIntegerType(type));
    }
}
