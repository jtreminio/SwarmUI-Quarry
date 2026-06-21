using System.Text.RegularExpressions;

namespace Quarry;

public static class DatasetNameMatching
{
    public static IReadOnlyList<string> SplitNames(string name)
    {
        List<string> parts = [];
        if (name is null)
        {
            return parts;
        }
        foreach (string raw in name.Split(','))
        {
            string part = raw.Trim();
            if (part.Length > 0)
            {
                parts.Add(part);
            }
        }
        return parts;
    }

    public static bool IsGlob(string pattern) => pattern is not null && (pattern.Contains('*') || pattern.Contains('?'));

    public static bool GlobMatches(string pattern, string candidate)
    {
        if (pattern is null || candidate is null)
        {
            return false;
        }
        StringBuilder regex = new("^");
        for (int i = 0; i < pattern.Length; i++)
        {
            char c = pattern[i];
            if (c == '*')
            {
                if (i + 1 < pattern.Length && pattern[i + 1] == '*')
                {
                    while (i + 1 < pattern.Length && pattern[i + 1] == '*')
                    {
                        i++;
                    }
                    regex.Append(".*");
                }
                else
                {
                    regex.Append("[^/]*");
                }
            }
            else
            {
                regex.Append(c == '?' ? "[^/]" : Regex.Escape(c.ToString()));
            }
        }
        regex.Append('$');
        return Regex.IsMatch(candidate, regex.ToString(), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }
}
