using SwarmUI.Text2Image;
using Xunit;

namespace Quarry.Tests;

[CollectionDefinition("QuarryTests")]
public class QuarryTestsCollection : ICollectionFixture<GlobalStateFixture>
{
}

/// <summary>Snapshots and restores SwarmUI's global prompt-tag dictionaries so tests that
/// mutate them (e.g. registering our prompt-tag processor) don't leak into other tests.</summary>
public sealed class GlobalStateFixture : IDisposable
{
    private readonly Dictionary<string, Func<string, T2IPromptHandling.PromptTagContext, string>> _promptBasic;
    private readonly Dictionary<string, Func<string, T2IPromptHandling.PromptTagContext, string>> _promptProcessors;
    private readonly Dictionary<string, Func<string, T2IPromptHandling.PromptTagContext, string>> _promptPost;
    private readonly Dictionary<string, Func<string, T2IPromptHandling.PromptTagContext, string>> _promptLength;

    public GlobalStateFixture()
    {
        _promptBasic = new(T2IPromptHandling.PromptTagBasicProcessors);
        _promptProcessors = new(T2IPromptHandling.PromptTagProcessors);
        _promptPost = new(T2IPromptHandling.PromptTagPostProcessors);
        _promptLength = new(T2IPromptHandling.PromptTagLengthEstimators);
    }

    public void Dispose()
    {
        T2IPromptHandling.PromptTagBasicProcessors = new(_promptBasic);
        T2IPromptHandling.PromptTagProcessors = new(_promptProcessors);
        T2IPromptHandling.PromptTagPostProcessors = new(_promptPost);
        T2IPromptHandling.PromptTagLengthEstimators = new(_promptLength);
    }
}
