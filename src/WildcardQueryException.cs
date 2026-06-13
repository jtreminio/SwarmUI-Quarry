namespace Quarry;

/// <summary>Base type for errors in a <c>&lt;wc:...&gt;</c> query — whether raised while parsing
/// the tag text or while building SQL against a dataset's schema. The wildcard handler catches
/// this and surfaces it as a prompt warning instead of failing the generation.</summary>
public class WildcardQueryException : Exception
{
    public WildcardQueryException(string message) : base(message)
    {
    }
}
