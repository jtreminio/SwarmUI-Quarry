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
        DatasetMigrator.RunInBackground();
        PromptTagHandler.Initialize();

        API.RegisterAPICall(QuarryGetSettings, false, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarrySaveSettings, true, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarrySetDatasetEnabled, true, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryRefresh, true, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryPreviewDataset, false, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryClearPreviewCache, true, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryCleanTempFiles, true, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryResolveReferences, false, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryRunQuery, false, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryInstallRequirements, true, Permissions.InstallFeatures);
        API.RegisterAPICall(QuarryListAvailableDatasets, false, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryDownloadDataset, true, Permissions.InstallFeatures);
        API.RegisterAPICall(QuarryDownloadStatus, false, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryCancelDownload, true, Permissions.InstallFeatures);
        API.RegisterAPICall(QuarryRescanImageHistory, true, Permissions.ViewImageHistory);
        API.RegisterAPICall(QuarryImageHistoryStatus, false, Permissions.ViewImageHistory);
        API.RegisterAPICall(QuarryCancelImageHistoryScan, true, Permissions.ViewImageHistory);
        API.RegisterAPICall(QuarrySearchImageHistory, false, Permissions.ViewImageHistory);
        API.RegisterAPICall(QuarryImageHistoryFields, false, Permissions.ViewImageHistory);

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
        ImageHistoryScanner.CancelAndWait(TimeSpan.FromSeconds(10));
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
            DatasetManager.ColumnSeparator = settings.Value<string>("columnSeparator") ?? ", ";
            DatasetManager.SetPromptColumns(ReadPromptColumns(settings["promptColumns"] as JObject));
            DatasetManager.SetTagColumns(ReadTagColumns(settings["tagColumns"] as JObject));
            DatasetManager.SetDisabledDatasets(ReadDisabledDatasets(settings["disabledDatasets"] as JArray));
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
                ["columnSeparator"] = DatasetManager.ColumnSeparator,
                ["promptColumns"] = promptColumns,
                ["tagColumns"] = tagColumns,
                ["disabledDatasets"] = new JArray(DatasetManager.GetDisabledDatasetsSnapshot()),
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

    private static List<string> ReadDisabledDatasets(JArray source)
    {
        List<string> result = [];
        if (source is not null)
        {
            foreach (JToken token in source)
            {
                string name = token?.ToString();
                if (!string.IsNullOrWhiteSpace(name))
                {
                    result.Add(name);
                }
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
                        ["numeric"] = column.IsNumeric,
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
                    ["sizeBytes"] = info.SizeBytes,
                    ["enabled"] = info.Enabled,
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

    public Task<JObject> QuarrySaveSettings(Session session, string datasetsFolder, string promptColumnsJson, string tagColumnsJson, string disabledDatasetsJson = "", bool addToExistingTag = true)
    {
        try
        {
            DatasetManager.DatasetsFolder = datasetsFolder ?? "";
            AddToExistingTag = addToExistingTag;
            JObject parsed = string.IsNullOrWhiteSpace(promptColumnsJson) ? [] : JObject.Parse(promptColumnsJson);
            DatasetManager.SetPromptColumns(ReadPromptColumns(parsed));
            JObject parsedTags = string.IsNullOrWhiteSpace(tagColumnsJson) ? [] : JObject.Parse(tagColumnsJson);
            DatasetManager.SetTagColumns(ReadTagColumns(parsedTags));
            JArray parsedDisabled = string.IsNullOrWhiteSpace(disabledDatasetsJson) ? [] : JArray.Parse(disabledDatasetsJson);
            DatasetManager.SetDisabledDatasets(ReadDisabledDatasets(parsedDisabled));
            DatasetManager.Sync();
            SaveSettings();
            return Task.FromResult(BuildSettingsResponse());
        }
        catch (Exception ex)
        {
            return Task.FromResult(new JObject { ["success"] = false, ["error"] = ex.Message });
        }
    }

    public Task<JObject> QuarrySetDatasetEnabled(Session session, string dataset, bool enabled)
    {
        if (string.IsNullOrWhiteSpace(dataset))
        {
            return Task.FromResult(new JObject { ["success"] = false, ["error"] = "No dataset specified." });
        }
        DatasetManager.SetDatasetEnabled(dataset, enabled);
        SaveSettings();
        return Task.FromResult(new JObject { ["success"] = true });
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
        (columns, rows) = ColumnSchema.StripCompanions(columns, rows);
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

    public Task<JObject> QuarryCleanTempFiles(Session session)
    {
        (int removed, string error) = DatasetManager.CleanTempFiles();
        return Task.FromResult(string.IsNullOrEmpty(error)
            ? new JObject { ["success"] = true, ["removed"] = removed }
            : new JObject { ["success"] = false, ["error"] = error });
    }

    public Task<JObject> QuarryResolveReferences(Session session, string prompt)
    {
        return Task.FromResult(new JObject
        {
            ["success"] = true,
            ["names"] = ToJArray(PromptTagHandler.ResolveReferencedDatasetNames(prompt ?? "")),
        });
    }

    public Task<JObject> QuarryRunQuery(Session session, string query, int maxResults = QueryRunner.DefaultMaxResults)
    {
        try
        {
            QueryRunResult result = QueryRunner.Run(query, maxResults);
            if (result.Invalid is not null)
            {
                return Task.FromResult(new JObject { ["invalid"] = result.Invalid });
            }
            JArray datasets = [];
            foreach (QueryRunMatch match in result.Datasets)
            {
                datasets.Add(new JObject { ["name"] = match.Name, ["matches"] = match.Matches });
            }
            JArray results = [];
            foreach (QueryRunRow row in result.Rows)
            {
                results.Add(new JObject { ["dataset"] = row.Dataset, ["prompt"] = row.Prompt });
            }
            return Task.FromResult(new JObject
            {
                ["total"] = result.Total,
                ["datasets"] = datasets,
                ["results"] = results,
                ["truncated"] = result.Truncated,
                ["highlights"] = ToJArray(result.Highlights),
            });
        }
        catch (Exception ex)
        {
            Logs.Error($"Quarry: run-query failed for '{query}': {ex.ReadableString()}");
            return Task.FromResult(new JObject { ["success"] = false, ["error"] = ex.Message });
        }
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

    public async Task<JObject> QuarryListAvailableDatasets(Session session, bool refresh = false)
    {
        try
        {
            List<RemoteDataset> datasets = await DatasetDownloader.ListAvailableAsync(GetHfToken(session), refresh);
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

    #region Image Search API endpoints
    public Task<JObject> QuarryRescanImageHistory(Session session)
    {
        (bool ok, string error, int id) = ImageHistoryScanner.Start(session);
        return Task.FromResult(ok
            ? new JObject { ["success"] = true, ["id"] = id }
            : new JObject { ["success"] = false, ["error"] = error });
    }

    public Task<JObject> QuarryImageHistoryStatus(Session session)
    {
        ImageHistoryScanner.ScanStatus status = ImageHistoryScanner.GetStatus(session.User.UserID);
        JObject response = new()
        {
            ["success"] = true,
            ["available"] = DatasetManager.RequirementsInstalled,
            ["hasIndex"] = ImageHistoryIndex.Exists(session.User.UserID),
            ["active"] = status.Active,
            ["id"] = status.Id,
            ["state"] = status.State,
            ["filesTotal"] = status.FilesTotal,
            ["filesDone"] = status.FilesDone,
            ["filesIndexed"] = status.FilesIndexed,
            ["filesPruned"] = status.FilesPruned,
        };
        if (!string.IsNullOrEmpty(status.Error))
        {
            response["scanError"] = status.Error;
        }
        return Task.FromResult(response);
    }

    public Task<JObject> QuarryCancelImageHistoryScan(Session session)
    {
        ImageHistoryScanner.Cancel(session.User.UserID);
        return Task.FromResult(new JObject { ["success"] = true });
    }

    public Task<JObject> QuarrySearchImageHistory(Session session, string filtersJson = "", string sortBy = "date", bool sortDescending = true, int limit = 100, int offset = 0)
    {
        try
        {
            JArray filters = string.IsNullOrWhiteSpace(filtersJson) ? [] : JArray.Parse(filtersJson);
            int clampedLimit = Math.Clamp(limit <= 0 ? 100 : limit, 1, 10000);
            int clampedOffset = Math.Max(0, offset);
            ImageSearchResult result = ImageHistorySearch.Search(session.User.UserID, filters, sortBy, sortDescending, clampedLimit, clampedOffset);
            return Task.FromResult(new JObject
            {
                ["success"] = true,
                ["available"] = DatasetManager.RequirementsInstalled,
                ["hasIndex"] = result.HasIndex,
                ["columns"] = ToJArray(result.Columns),
                ["rows"] = new JArray(result.Rows.Select(ToJArray)),
                ["total"] = result.Total,
                ["returned"] = result.Rows.Count,
                ["offset"] = clampedOffset,
                ["warnings"] = ToJArray(result.Warnings),
            });
        }
        catch (Exception ex)
        {
            return Task.FromResult(new JObject { ["success"] = false, ["error"] = ex.Message });
        }
    }

    public Task<JObject> QuarryImageHistoryFields(Session session)
    {
        (IReadOnlyList<ImageSearchField> core, IReadOnlyList<string> discovered) = ImageHistorySearch.Fields(session.User.UserID);
        JArray coreArr = [];
        foreach (ImageSearchField field in core)
        {
            coreArr.Add(new JObject
            {
                ["name"] = field.Column,
                ["label"] = field.Label,
                ["type"] = field.Type.ToString().ToLowerInvariant(),
            });
        }
        JObject operators = [];
        foreach ((string type, IReadOnlyList<ImageSearchOperator> ops) in ImageSearchFilterBuilder.OperatorsByType)
        {
            JArray opArr = [];
            foreach (ImageSearchOperator op in ops)
            {
                opArr.Add(new JObject { ["value"] = op.Value, ["label"] = op.Label });
            }
            operators[type] = opArr;
        }
        return Task.FromResult(new JObject
        {
            ["success"] = true,
            ["available"] = DatasetManager.RequirementsInstalled,
            ["hasIndex"] = ImageHistoryIndex.Exists(session.User.UserID),
            ["coreFields"] = coreArr,
            ["discoveredFields"] = ToJArray(discovered),
            ["operators"] = operators,
        });
    }
    #endregion
}
