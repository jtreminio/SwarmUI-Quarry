namespace Quarry;

/// <summary>An error in a <c>&lt;q:...&gt;</c> query, raised while parsing the tag or building SQL against a
/// dataset schema. The handler surfaces it as a prompt warning instead of failing the generation.</summary>
public class WildcardQueryException : Exception
{
    public WildcardQueryException(string message) : base(message)
    {
    }
}
