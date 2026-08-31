namespace Quarry;

public class QueryException(string message) : Exception(message)
{
}

public sealed class NonNumericComparisonException(string column) : QueryException(
    $"column '{column}' is list-based, so the '+=' / '-=' comparison cannot apply.")
{
    public string Column { get; } = column;
}
