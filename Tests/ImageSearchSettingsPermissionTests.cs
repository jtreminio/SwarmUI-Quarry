using System.Reflection;
using System.Runtime.CompilerServices;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using Xunit;

namespace Quarry.Tests;

[Collection("OutputColumns")]
public sealed class ImageSearchSettingsPermissionTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "quarry-permissions-" + Guid.NewGuid().ToString("N"));
    private readonly string oldDataDir = Program.DataDir;
    private readonly string oldOutput = Program.ServerSettings.Paths.OutputPath;
    private readonly bool oldAppendUser = Program.ServerSettings.Paths.AppendUserNameToOutputPath;
    private readonly string oldDatasets = DatasetManager.DatasetsFolder;
    private readonly string oldExtension = DatasetManager.ExtensionFolder;
    private readonly Dictionary<string, string> oldPromptColumns = new(DatasetManager.GetPromptColumnsSnapshot());
    private readonly Dictionary<string, IReadOnlyList<string>> oldTagColumns = new(DatasetManager.GetTagColumnsSnapshot());
    private readonly string[] oldDisabled = [.. DatasetManager.GetDisabledDatasetsSnapshot()];
    private readonly Dictionary<FieldInfo, object> oldSettings = typeof(QuarryExtension)
        .GetFields(BindingFlags.NonPublic | BindingFlags.Static)
        .Where(field => field.Name is "ImageSearchDirectories" or "AddToExistingTag")
        .ToDictionary(field => field, field => field.GetValue(null));
    private readonly QuarryExtension extension = new();

    public ImageSearchSettingsPermissionTests()
    {
        Directory.CreateDirectory(Path.Combine(root, "output", "Starred", "private-name"));
        Directory.CreateDirectory(Path.Combine(root, "datasets"));
        Program.DataDir = root;
        Program.ServerSettings.Paths.OutputPath = Path.Combine(root, "output");
        Program.ServerSettings.Paths.AppendUserNameToOutputPath = false;
        DatasetManager.DatasetsFolder = Path.Combine(root, "datasets");
        DatasetManager.ExtensionFolder = root;
        DatasetManager.Sync();
    }

    private static Session MakeSession(bool canViewHistory)
    {
        User user = (User)RuntimeHelpers.GetUninitializedObject(typeof(User));
        user.Data = new User.DatabaseEntry { ID = "test" };
        user.CalculatedRole = new Role("test");
        user.CalculatedRole.Data.PermissionFlags.Add(Permissions.FundamentalGenerateTabAccess.ID);
        if (canViewHistory)
        {
            user.CalculatedRole.Data.PermissionFlags.Add(Permissions.ViewImageHistory.ID);
        }
        return new Session { User = user };
    }

    private async Task SaveSelection()
    {
        JObject saved = await extension.QuarrySaveSettings(MakeSession(true), DatasetManager.DatasetsFolder, "{}", "{}", imageSearchDirectoriesJson: "[\"Starred\"]");
        Assert.True(saved.Value<bool>("success"));
    }

    private static void AssertNoHistory(JObject response)
    {
        Assert.True(response.Value<bool>("success"));
        Assert.False(response.Value<bool>("canViewImageHistory"));
        Assert.Null(response["imageSearchDirectories"]);
        Assert.Null(response["imageSearchDirectoryOptions"]);
    }

    [Fact]
    public async Task GetSettings_HidesSavedAndDiscoveredFoldersWithoutHistoryPermission()
    {
        await SaveSelection();
        AssertNoHistory(await extension.QuarryGetSettings(MakeSession(false)));
        JObject allowed = await extension.QuarryGetSettings(MakeSession(true));
        Assert.True(allowed.Value<bool>("canViewImageHistory"));
        Assert.Equal(new[] { "Starred" }, allowed["imageSearchDirectories"].Values<string>());
        Assert.Contains("Starred/private-name", allowed["imageSearchDirectoryOptions"].Values<string>());
    }

    [Fact]
    public async Task SaveSettings_RejectsUnauthorizedSelectionBeforeAnyChanges()
    {
        await SaveSelection();
        string before = File.ReadAllText(Path.Combine(root, "Quarry.json"));
        JObject rejected = await extension.QuarrySaveSettings(MakeSession(false), "changed", "{}", "{}", imageSearchDirectoriesJson: "[]");
        Assert.False(rejected.Value<bool>("success"));
        Assert.Contains("permission", rejected.Value<string>("error"));
        Assert.Equal(Path.Combine(root, "datasets"), DatasetManager.DatasetsFolder);
        Assert.Equal(before, File.ReadAllText(Path.Combine(root, "Quarry.json")));
        JObject allowed = await extension.QuarryGetSettings(MakeSession(true));
        Assert.Equal(new[] { "Starred" }, allowed["imageSearchDirectories"].Values<string>());
    }

    [Fact]
    public async Task SaveSettings_StillAllowsDatasetSettingsWithoutHistoryPermission()
    {
        await SaveSelection();
        JObject saved = await extension.QuarrySaveSettings(MakeSession(false), DatasetManager.DatasetsFolder, "{}", "{}", addToExistingTag: false);
        AssertNoHistory(saved);
        Assert.False(saved.Value<bool>("addToExistingTag"));
        JObject persisted = JObject.Parse(File.ReadAllText(Path.Combine(root, "Quarry.json")));
        Assert.Equal(new[] { "Starred" }, persisted["imageSearchDirectories"].Values<string>());
    }

    [Fact]
    public async Task DeletedSelection_IsHiddenOnLoadAndRemovedOnSave()
    {
        await SaveSelection();
        Directory.Delete(Path.Combine(root, "output", "Starred"), true);
        JObject loaded = await extension.QuarryGetSettings(MakeSession(true));
        Assert.Empty(loaded["imageSearchDirectories"]);
        Assert.Empty(loaded["imageSearchDirectoryOptions"]);
        // Loading does not mutate settings. Saving also handles folders deleted after the page loaded.
        JObject before = JObject.Parse(File.ReadAllText(Path.Combine(root, "Quarry.json")));
        Assert.Equal(new[] { "Starred" }, before["imageSearchDirectories"].Values<string>());
        JObject saved = await extension.QuarrySaveSettings(MakeSession(true), DatasetManager.DatasetsFolder, "{}", "{}", imageSearchDirectoriesJson: "[\"Starred\"]");
        Assert.True(saved.Value<bool>("success"));
        Assert.Empty(saved["imageSearchDirectories"]);
        JObject persisted = JObject.Parse(File.ReadAllText(Path.Combine(root, "Quarry.json")));
        Assert.Empty(persisted["imageSearchDirectories"]);
    }

    public void Dispose()
    {
        Program.DataDir = oldDataDir;
        Program.ServerSettings.Paths.OutputPath = oldOutput;
        Program.ServerSettings.Paths.AppendUserNameToOutputPath = oldAppendUser;
        foreach ((FieldInfo field, object value) in oldSettings)
        {
            field.SetValue(null, value);
        }
        DatasetManager.SetPromptColumns(oldPromptColumns);
        DatasetManager.SetTagColumns(oldTagColumns);
        DatasetManager.SetDisabledDatasets(oldDisabled);
        DatasetManager.DatasetsFolder = "";
        DatasetManager.Sync();
        DatasetManager.ExtensionFolder = oldExtension;
        DatasetManager.DatasetsFolder = oldDatasets;
        if (!string.IsNullOrWhiteSpace(oldDatasets))
        {
            DatasetManager.Sync();
        }
        Directory.Delete(root, true);
    }
}
