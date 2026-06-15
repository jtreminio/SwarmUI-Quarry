namespace Quarry;

// Picks the column supplying prompt text: configured if it exists, else a conventional name, else the first column.
public static class PromptColumnResolver
{
    private static readonly string[] PreferredNames = ["prompt", "text", "caption", "description", "value"];

    // Returns the canonical-cased column name, or null when the schema has no columns.
    public static string Resolve(string configuredColumn, ColumnSchema schema)
    {
        if (!string.IsNullOrWhiteSpace(configuredColumn) && schema.TryGet(configuredColumn, out ColumnInfo configured))
        {
            return configured.Name;
        }
        foreach (string preferred in PreferredNames)
        {
            if (schema.TryGet(preferred, out ColumnInfo match))
            {
                return match.Name;
            }
        }
        return schema.Columns.Count > 0 ? schema.Columns[0].Name : null;
    }
}
