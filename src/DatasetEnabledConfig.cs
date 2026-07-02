namespace Quarry;

public static class DatasetEnabledConfig
{
    private static readonly HashSet<string> Disabled = new(StringComparer.OrdinalIgnoreCase);
    private static readonly object Lock = new();

    public static bool IsEnabled(string name)
    {
        if (name is null)
        {
            return true;
        }
        lock (Lock)
        {
            return !Disabled.Contains(name);
        }
    }

    public static void SetEnabled(string name, bool enabled)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return;
        }
        lock (Lock)
        {
            if (enabled)
            {
                Disabled.Remove(name.Trim());
            }
            else
            {
                Disabled.Add(name.Trim());
            }
        }
    }

    public static void SetDisabled(IEnumerable<string> names)
    {
        lock (Lock)
        {
            Disabled.Clear();
            if (names is null)
            {
                return;
            }
            foreach (string name in names)
            {
                if (!string.IsNullOrWhiteSpace(name))
                {
                    Disabled.Add(name.Trim());
                }
            }
        }
    }

    public static IReadOnlyList<string> GetDisabledSnapshot()
    {
        lock (Lock)
        {
            return [.. Disabled];
        }
    }
}
