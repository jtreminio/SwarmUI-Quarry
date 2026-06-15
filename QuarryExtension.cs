using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Utils;
using SwarmUI.WebAPI;
using System.IO;

namespace Quarry;

public class QuarryExtension : Extension
{
    private string SettingsFilePath => $"{Program.DataDir}/Quarry.json";
    private static readonly SemaphoreSlim InstallLock = new(1, 1);
    private static bool AddToExistingTag = true;

    public override void OnPreInit()
    {
        ScriptFiles.Add("Assets/quarry.js");
        StyleSheetFiles.Add("Assets/quarry.css");
    }

    public override void OnInit()
    {
        DatasetManager.ExtensionFolder = FilePath;
        LoadSettings();
        ApplyDefaultDatasetsFolder();
        DatasetManager.Initialize();
        WildcardHandler.Initialize();

        API.RegisterAPICall(QuarryGetSettings, false, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarrySaveSettings, true, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryRefresh, true, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryPreviewDataset, false, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryClearPreviewCache, true, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryResolveReferences, false, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryInstallRequirements, true, Permissions.InstallFeatures);
        API.RegisterAPICall(QuarryListAvailableDatasets, false, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryDownloadDataset, true, Permissions.InstallFeatures);
        API.RegisterAPICall(QuarryDownloadStatus, false, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryCancelDownload, true, Permissions.InstallFeatures);

        string status = DatasetManager.IsActive ? $"enabled, folder: {DatasetManager.DatasetsFolder}" : "disabled";
        Logs.Info($"Quarry extension initialized ({status}).");
    }

    private static void ApplyDefaultDatasetsFolder()
    {
        if (!string.IsNullOrWhiteSpace(DatasetManager.DatasetsFolder))
        {
            return;
        }
        string parent = Path.GetDirectoryName(WildcardsHelper.Folder.TrimEnd('/', '\\'));
        if (string.IsNullOrEmpty(parent))
        {
            return;
        }
        DatasetManager.DatasetsFolder = Path.Combine(parent, "Quarry");
        try
        {
            Directory.CreateDirectory(DatasetManager.DatasetsFolder);
        }
        catch (Exception ex)
        {
            Logs.Warning($"Quarry: could not create default datasets folder '{DatasetManager.DatasetsFolder}': {ex.Message}");
        }
    }

    public override void OnShutdown()
    {
        DatasetManager.Shutdown();
    }

    private static JArray ToJArray(IEnumerable<string> values)
    {
        JArray array = [];
        foreach (string value in values)
        {
            array.Add(value);
        }
        return array;
    }

    #region Settings persistence
    private void LoadSettings()
    {
        try
        {
            if (!File.Exists(SettingsFilePath))
            {
                return;
            }
            JObject settings = JObject.Parse(File.ReadAllText(SettingsFilePath));
            DatasetManager.DatasetsFolder = settings.Value<string>("datasetsFolder") ?? "";
            AddToExistingTag = settings.Value<bool?>("addToExistingTag") ?? true;
            DatasetManager.SetPromptColumns(ReadPromptColumns(settings["promptColumns"] as JObject));
            DatasetManager.SetTagColumns(ReadTagColumns(settings["tagColumns"] as JObject));
        }
        catch (Exception ex)
        {
            Logs.Warning($"Quarry: failed to load settings: {ex.Message}");
        }
    }

    private void SaveSettings()
    {
        try
        {
            JObject promptColumns = [];
            foreach ((string name, string column) in DatasetManager.GetPromptColumnsSnapshot())
            {
                promptColumns[name] = column;
            }
            JObject tagColumns = [];
            foreach ((string name, IReadOnlyList<string> columns) in DatasetManager.GetTagColumnsSnapshot())
            {
                tagColumns[name] = new JArray(columns);
            }
            JObject settings = new()
            {
                ["datasetsFolder"] = DatasetManager.DatasetsFolder,
                ["addToExistingTag"] = AddToExistingTag,
                ["promptColumns"] = promptColumns,
                ["tagColumns"] = tagColumns,
            };
            File.WriteAllText(SettingsFilePath, settings.ToString());
        }
        catch (Exception ex)
        {
            Logs.Warning($"Quarry: failed to save settings: {ex.Message}");
        }
    }

    private static Dictionary<string, string> ReadPromptColumns(JObject source)
    {
        Dictionary<string, string> result = new(StringComparer.OrdinalIgnoreCase);
        if (source is not null)
        {
            foreach (JProperty property in source.Properties())
            {
                result[property.Name] = property.Value?.ToString() ?? "";
            }
        }
        return result;
    }

    private static Dictionary<string, IReadOnlyList<string>> ReadTagColumns(JObject source)
    {
        Dictionary<string, IReadOnlyList<string>> result = new(StringComparer.OrdinalIgnoreCase);
        if (source is not null)
        {
            foreach (JProperty property in source.Properties())
            {
                List<string> columns = property.Value is JArray array
                    ? [.. array.Select(token => token?.ToString()).Where(value => !string.IsNullOrWhiteSpace(value))]
                    : [];
                result[property.Name] = columns;
            }
        }
        return result;
    }
    #endregion

    #region API endpoints
    private static JObject BuildSettingsResponse(bool includeRowCounts = false)
    {
        bool requirementsInstalled = DatasetManager.RequirementsInstalled;
        JArray datasets = [];
        if (requirementsInstalled)
        {
            foreach (DatasetInfo info in DatasetManager.GetDatasetsInfo(includeRowCounts))
            {
                JArray columns = [];
                foreach (ColumnInfo column in info.Columns)
                {
                    columns.Add(new JObject
                    {
                        ["name"] = column.Name,
                        ["kind"] = column.Kind.ToString().ToLowerInvariant(),
                    });
                }
                datasets.Add(new JObject
                {
                    ["name"] = info.Name,
                    ["columns"] = columns,
                    ["resolvedPromptColumn"] = info.ResolvedPromptColumn,
                    ["configuredPromptColumn"] = info.ConfiguredPromptColumn,
                    ["configuredTagColumns"] = ToJArray(info.ConfiguredTagColumns),
                    ["rowCount"] = info.RowCount,
                    ["error"] = info.Error,
                });
            }
        }
        return new JObject
        {
            ["success"] = true,
            ["datasetsFolder"] = DatasetManager.DatasetsFolder,
            ["addToExistingTag"] = AddToExistingTag,
            ["active"] = DatasetManager.IsActive,
            ["requirementsInstalled"] = requirementsInstalled,
            ["count"] = DatasetManager.Count,
            ["datasets"] = datasets,
        };
    }

    public Task<JObject> QuarryGetSettings(Session session)
    {
        return Task.FromResult(BuildSettingsResponse());
    }

    public Task<JObject> QuarrySaveSettings(Session session, string datasetsFolder, string promptColumnsJson, string tagColumnsJson, bool addToExistingTag = true)
    {
        try
        {
            DatasetManager.DatasetsFolder = datasetsFolder ?? "";
            AddToExistingTag = addToExistingTag;
            JObject parsed = string.IsNullOrWhiteSpace(promptColumnsJson) ? [] : JObject.Parse(promptColumnsJson);
            DatasetManager.SetPromptColumns(ReadPromptColumns(parsed));
            JObject parsedTags = string.IsNullOrWhiteSpace(tagColumnsJson) ? [] : JObject.Parse(tagColumnsJson);
            DatasetManager.SetTagColumns(ReadTagColumns(parsedTags));
            DatasetManager.Sync();
            SaveSettings();
            return Task.FromResult(BuildSettingsResponse());
        }
        catch (Exception ex)
        {
            return Task.FromResult(new JObject { ["success"] = false, ["error"] = ex.Message });
        }
    }

    public Task<JObject> QuarryRefresh(Session session)
    {
        (bool success, int count, string message, string error) = DatasetManager.Refresh();
        if (!success)
        {
            return Task.FromResult(new JObject { ["success"] = false, ["error"] = error });
        }
        int warmed = DatasetManager.WarmAll();
        JObject response = BuildSettingsResponse(includeRowCounts: true);
        response["message"] = warmed > 0 ? $"{message} Warmed {warmed} dataset(s)." : message;
        response["count"] = count;
        return Task.FromResult(response);
    }

    public Task<JObject> QuarryPreviewDataset(Session session, string dataset, int limit = DatasetManager.DefaultPreviewLimit)
    {
        int clamped = Math.Clamp(limit <= 0 ? DatasetManager.DefaultPreviewLimit : limit, 1, DatasetManager.MaxPreviewLimit);
        (bool success, List<string> columns, List<List<string>> rows, string error) = DatasetManager.PreviewDataset(dataset, clamped);
        if (!success)
        {
            return Task.FromResult(new JObject { ["success"] = false, ["error"] = error });
        }
        JObject response = new()
        {
            ["success"] = true,
            ["dataset"] = dataset,
            ["columns"] = ToJArray(columns),
            ["rows"] = new JArray(rows.Select(ToJArray)),
        };
        (bool countSuccess, long? rowCount, _) = DatasetManager.GetUsableRowCount(dataset);
        if (countSuccess && rowCount is not null)
        {
            response["rowCount"] = rowCount.Value;
        }
        return Task.FromResult(response);
    }

    public Task<JObject> QuarryClearPreviewCache(Session session, string dataset)
    {
        return Task.FromResult(DatasetManager.ClearPreviewCache(dataset)
            ? new JObject { ["success"] = true }
            : new JObject { ["success"] = false, ["error"] = $"Unknown dataset '{dataset}'." });
    }

    public Task<JObject> QuarryResolveReferences(Session session, string prompt)
    {
        return Task.FromResult(new JObject
        {
            ["success"] = true,
            ["names"] = ToJArray(WildcardHandler.ResolveReferencedDatasetNames(prompt ?? "")),
        });
    }

    public async Task<JObject> QuarryInstallRequirements(Session session)
    {
        await InstallLock.WaitAsync(Program.GlobalProgramCancel);
        try
        {
            if (DatasetManager.RequirementsInstalled)
            {
                return new JObject { ["success"] = true };
            }
            await Task.Run(DatasetManager.InstallRequirements);
            DatasetManager.Refresh();
            return new JObject { ["success"] = true };
        }
        catch (Exception ex)
        {
            Logs.Error($"Quarry: failed to install requirements: {ex.Message}");
            return new JObject { ["success"] = false, ["error"] = ex.Message };
        }
        finally
        {
            InstallLock.Release();
        }
    }

    private static string GetHfToken(Session session) => session?.User?.GetGenericData("huggingface_api", "key") ?? "";

    public async Task<JObject> QuarryListAvailableDatasets(Session session)
    {
        try
        {
            List<RemoteDataset> datasets = await DatasetDownloader.ListAvailableAsync(GetHfToken(session));
            JArray arr = [];
            foreach (RemoteDataset dataset in datasets)
            {
                arr.Add(new JObject
                {
                    ["name"] = dataset.Name,
                    ["repoPath"] = dataset.RepoPath,
                    ["sizeBytes"] = dataset.SizeBytes,
                    ["fileCount"] = dataset.FileCount,
                    ["installed"] = dataset.Installed,
                });
            }
            return new JObject
            {
                ["success"] = true,
                ["repo"] = DatasetDownloader.RepoId,
                ["repoUrl"] = DatasetDownloader.RepoUrl,
                ["tokenSet"] = !string.IsNullOrEmpty(GetHfToken(session)),
                ["datasets"] = arr,
            };
        }
        catch (Exception ex)
        {
            return new JObject { ["success"] = false, ["error"] = ex.Message };
        }
    }

    public async Task<JObject> QuarryDownloadDataset(Session session, string dataset, bool redownload = false)
    {
        (bool ok, string error, int id) = await DatasetDownloader.StartDownloadAsync(dataset, redownload, GetHfToken(session));
        return ok
            ? new JObject { ["success"] = true, ["id"] = id }
            : new JObject { ["success"] = false, ["error"] = error };
    }

    public Task<JObject> QuarryDownloadStatus(Session session)
    {
        DatasetDownloader.DownloadStatus status = DatasetDownloader.GetStatus();
        JObject response = new()
        {
            ["success"] = true,
            ["active"] = status.Active,
            ["id"] = status.Id,
            ["dataset"] = status.Dataset,
            ["state"] = status.State,
            ["bytesDone"] = status.BytesDone,
            ["bytesTotal"] = status.BytesTotal,
            ["filesDone"] = status.FilesDone,
            ["filesTotal"] = status.FilesTotal,
            ["perSecond"] = status.PerSecond,
        };
        if (!string.IsNullOrEmpty(status.Error))
        {
            response["error"] = status.Error;
        }
        return Task.FromResult(response);
    }

    public Task<JObject> QuarryCancelDownload(Session session)
    {
        DatasetDownloader.Cancel();
        return Task.FromResult(new JObject { ["success"] = true });
    }
    #endregion
}
