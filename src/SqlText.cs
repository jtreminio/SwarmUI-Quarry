namespace Quarry;

public static class SqlText
{
    public static string QuoteIdentifier(string identifier) => $"\"{identifier.Replace("\"", "\"\"")}\"";

    public static string QuoteLiteral(string literal) => $"'{literal.Replace("'", "''")}'";
}
