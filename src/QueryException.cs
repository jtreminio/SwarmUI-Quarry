namespace Quarry;

public class QueryException(string message) : Exception(message)
{
}

public sealed class NonNumericComparisonException(string column) : QueryException(
    $"column '{column}' contains an object selection; '+=' / '-=' requires a number, text, or an array column.")
{
    public string Column { get; } = column;
}
