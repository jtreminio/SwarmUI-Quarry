using System.IO;
using System.Security.Cryptography;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Quarry.Tests;

[Collection("OutputColumns")]
public sealed class NestedStorageLayoutTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "quarry-storage-layout-" + Guid.NewGuid().ToString("N"));
    private string Manifest => Path.Combine(_root, "_versions", "1.manifest");
    private string Descriptor => Path.Combine(_root, CasingStorage.DescriptorName);

    public NestedStorageLayoutTests()
    {
        Directory.CreateDirectory(Path.Combine(_root, "_versions"));
        File.WriteAllText(Manifest, "original manifest");
    }

    private JObject WriteDescriptor(bool casing = false)
    {
        JObject descriptor = new()
        {
            ["version"] = 2, ["search_version"] = 1,
            ["columns"] = casing ? new JObject { ["style"] = "style__case" } : new JObject(),
            ["stable_row_ids"] = false, ["helpers_indexed"] = true,
            ["helpers"] = new JArray(new JObject
            {
                ["column"] = "prompt", ["field"] = "hair", ["kind"] = "list", ["physical"] = "__quarry_search_0",
            }),
            ["snapshot"] = new JObject
            {
                ["manifest"] = "_versions/1.manifest", ["sha256"] = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Manifest))).ToLowerInvariant(),
            },
        };
        File.WriteAllText(Descriptor, descriptor.ToString());
        return descriptor;
    }

    [Fact]
    public void MatchingSnapshotEnablesSearchAndKeepsCasingMappings()
    {
        WriteDescriptor(casing: true);
        StorageLayout layout = CasingStorage.LoadLayout(_root);
        Assert.True(layout.SnapshotMatches);
        Assert.True(layout.CanUseSearchHelpers);
        Assert.Equal("style__case", layout.Columns["style"]);
        Assert.Equal(new SearchHelper("prompt", "hair", "list", "__quarry_search_0"), Assert.Single(layout.Helpers));
    }

    [Theory]
    [InlineData("bytes")]
    [InlineData("additional manifest")]
    [InlineData("missing manifest")]
    [InlineData("missing snapshot")]
    public void StalePlainDescriptorHidesHelpersButNeverUsesThem(string change)
    {
        JObject descriptor = WriteDescriptor();
        if (change == "bytes")
        {
            File.WriteAllText(Manifest, "modified manifest");
        }

        if (change == "additional manifest")
        {
            File.WriteAllText(Path.Combine(_root, "_versions", "2.manifest"), "new version");
        }

        if (change == "missing manifest")
        {
            File.Delete(Manifest);
        }

        if (change == "missing snapshot") { descriptor.Remove("snapshot"); File.WriteAllText(Descriptor, descriptor.ToString()); }
        StorageLayout layout = CasingStorage.LoadLayout(_root);
        Assert.False(layout.SnapshotMatches);
        Assert.False(layout.CanUseSearchHelpers);
        Assert.Contains(layout.Helpers, helper => helper.Physical == "__quarry_search_0");
    }

    [Fact]
    public void StaleCasingDescriptorFailsClosed()
    {
        WriteDescriptor(casing: true);
        File.WriteAllText(Manifest, "modified manifest");
        Assert.Contains("snapshot changed", Assert.Throws<InvalidDataException>(() => CasingStorage.LoadLayout(_root)).Message);
    }

    [Theory]
    [InlineData("stable_row_ids", true)]
    [InlineData("helpers_indexed", false)]
    public void UnsafeOrderingOrUnverifiedCoverageDisablesCandidates(string setting, bool value)
    {
        JObject descriptor = WriteDescriptor();
        descriptor[setting] = value;
        File.WriteAllText(Descriptor, descriptor.ToString());
        StorageLayout layout = CasingStorage.LoadLayout(_root);
        Assert.True(layout.SnapshotMatches);
        Assert.False(layout.CanUseSearchHelpers);
    }

    [Fact]
    public void UnknownSearchVersionKeepsOriginalDataReadableWithoutAcceleration()
    {
        JObject descriptor = WriteDescriptor(casing: true);
        descriptor["search_version"] = 99;
        File.WriteAllText(Descriptor, descriptor.ToString());
        StorageLayout layout = CasingStorage.LoadLayout(_root);
        Assert.True(layout.SnapshotMatches);
        Assert.False(layout.CanUseSearchHelpers);
        Assert.Equal("style__case", layout.Columns["style"]);
        Assert.Contains(layout.Helpers, helper => helper.Physical == "__quarry_search_0");
    }

    [Theory]
    [InlineData("kind", "array")]
    [InlineData("physical", "prompt")]
    [InlineData("field", "")]
    public void MalformedHelperMappingsAreRejected(string key, string value)
    {
        JObject descriptor = WriteDescriptor();
        descriptor["helpers"][0][key] = value;
        File.WriteAllText(Descriptor, descriptor.ToString());
        Assert.Throws<InvalidDataException>(() => CasingStorage.LoadLayout(_root));
    }

    [Fact]
    public void DuplicateHelperIdentitiesAreRejected()
    {
        JObject descriptor = WriteDescriptor();
        ((JArray)descriptor["helpers"]).Add(descriptor["helpers"][0].DeepClone());
        File.WriteAllText(Descriptor, descriptor.ToString());
        Assert.Throws<InvalidDataException>(() => CasingStorage.LoadLayout(_root));
    }

    [Fact]
    public void StorageIdentityUsesBytesAndSurvivesRelocation()
    {
        WriteDescriptor();
        string original = DatasetManager.ComputeHash(_root);
        DateTime manifestTime = File.GetLastWriteTimeUtc(Manifest);
        File.WriteAllText(Manifest, "modified manifest");
        File.SetLastWriteTimeUtc(Manifest, manifestTime);
        string changedManifest = DatasetManager.ComputeHash(_root);
        Assert.NotEqual(original, changedManifest);
        DateTime descriptorTime = File.GetLastWriteTimeUtc(Descriptor);
        File.AppendAllText(Descriptor, " ");
        File.SetLastWriteTimeUtc(Descriptor, descriptorTime);
        string changedDescriptor = DatasetManager.ComputeHash(_root);
        Assert.NotEqual(changedManifest, changedDescriptor);
        string relocated = _root + "-moved";
        Directory.Move(_root, relocated);
        try { Assert.Equal(changedDescriptor, DatasetManager.ComputeHash(relocated)); }
        finally { Directory.Move(relocated, _root); }
    }

    private static ColumnSchema Schema() => new([
        new ColumnInfo("__quarry_search_0", ColumnKind.Scalar, hasNgramIndex: true, isSearchHelper: true),
        new ColumnInfo("prompt", ColumnKind.List, dataType: "STRUCT(hair VARCHAR)[]"),
        new ColumnInfo("__quarry_search_user", ColumnKind.Scalar),
    ], [new SearchHelper("prompt", "hair", "list", "__quarry_search_0")]);

    [Fact]
    public void HelpersAreHiddenAndBlockedButUnmappedNamesRemainUserColumns()
    {
        ColumnSchema schema = Schema();
        Assert.Equal(new[] { "prompt", "__quarry_search_user" }, schema.VisibleColumns.Select(c => c.Name));
        string physical = Assert.Single(schema.SearchHelpers).Physical;
        Assert.Equal("__quarry_search_0", physical);
        Assert.Equal("prompt", PromptColumnResolver.Resolve(null, schema));
        Assert.Throws<QueryException>(() => PromptColumnResolver.ResolveOutputColumns([physical], null, schema));
        Assert.Throws<QueryException>(() => FieldPath.Resolve(physical, schema));
        Assert.Empty(TagColumnResolver.Resolve([physical], schema, physical));
        Assert.Equal("__quarry_search_user", FieldPath.Resolve("__quarry_search_user", schema).Column.Name);
    }

    [Fact]
    public void SchemaCacheRoundTripRetainsHiddenFlagsAndTrustedMappings()
    {
        string originalFolder = DatasetManager.ExtensionFolder;
        string key = Guid.NewGuid().ToString("N");
        try
        {
            DatasetManager.ExtensionFolder = _root;
            DatasetCache.StoreSchema(key, "snapshot", Schema());
            DatasetCache.PersistIfDirty();
            DatasetCache.Remove(key);
            DatasetCache.Load();
            Assert.True(DatasetCache.TryGetSchema(key, "snapshot", out ColumnSchema loaded));
            SearchHelper helper = Assert.Single(loaded.SearchHelpers);
            Assert.Equal(new SearchHelper("prompt", "hair", "list", "__quarry_search_0"), helper);
            string physical = helper.Physical;
            Assert.True(loaded.IsCompanionName(physical));
            Assert.Equal(new[] { "prompt", "__quarry_search_user" }, loaded.VisibleColumns.Select(c => c.Name));
            Assert.False(DatasetCache.TryGetSchema(key, "new snapshot", out _));
        }
        finally { DatasetCache.Remove(key); DatasetManager.ExtensionFolder = originalFolder; }
    }

    public void Dispose() => Directory.Delete(_root, true);
}
