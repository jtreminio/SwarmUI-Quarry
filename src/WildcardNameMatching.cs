using System.Text.RegularExpressions;

namespace Quarry;

/// <summary>Expands the NAME portion of a <c>&lt;wc:NAME[...]&gt;</c> reference that may target more than one
/// dataset: a comma-separated list (<c>a,b,c</c>) and/or glob patterns (<c>quarry/*</c>). Pure and
/// side-effect free — the handler maps the resulting names/patterns onto actual datasets.</summary>
public static class WildcardNameMatching
{
    /// <summary>Splits a reference name on commas, trims each part, and drops empties. A bare name with no
    /// comma yields a single-element list.</summary>
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

    /// <summary>True when the pattern contains a glob metacharacter (<c>*</c> or <c>?</c>).</summary>
    public static bool IsGlob(string pattern) => pattern is not null && (pattern.Contains('*') || pattern.Contains('?'));

    /// <summary>Case-insensitive glob match anchored to the whole candidate. <c>*</c> matches any run of
    /// characters (including <c>/</c>); <c>?</c> matches a single character; every other character is
    /// literal.</summary>
    public static bool GlobMatches(string pattern, string candidate)
    {
        if (pattern is null || candidate is null)
        {
            return false;
        }
        StringBuilder regex = new("^");
        foreach (char c in pattern)
        {
            regex.Append(c switch
            {
                '*' => ".*",
                '?' => ".",
                _ => Regex.Escape(c.ToString()),
            });
        }
        regex.Append('$');
        return Regex.IsMatch(candidate, regex.ToString(), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }
}
