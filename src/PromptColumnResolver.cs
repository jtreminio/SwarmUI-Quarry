namespace Quarry;

/// <summary>Decides which column supplies a dataset's prompt text: the user-configured column when it
/// exists in the schema, otherwise an auto-pick — a conventionally named column if present, else the
/// first column. Pure and side-effect free.</summary>
public static class PromptColumnResolver
{
    private static readonly string[] PreferredNames = ["prompt", "text", "caption", "description", "value"];

    /// <summary>Returns the resolved (canonical-cased) column name, or null when the schema has no columns.</summary>
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
