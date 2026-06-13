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

    public override void OnPreInit()
    {
        ScriptFiles.Add("Assets/quarry.js");
        StyleSheetFiles.Add("Assets/quarry.css");
    }

    public override void OnInit()
    {
        LoadSettings();
        DatasetManager.Initialize();

        API.RegisterAPICall(QuarryGetSettings, false, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarrySaveSettings, true, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryRefresh, true, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryPreviewDataset, false, Permissions.FundamentalGenerateTabAccess);

        string status = DatasetManager.IsActive ? $"enabled, folder: {DatasetManager.DatasetsFolder}" : "disabled";
        Logs.Info($"Quarry extension initialized ({status}).");
    }

    public override void OnPreLaunch()
    {
        // Register the wc/wildcard hook in OnPreLaunch (which runs AFTER every extension's OnInit) so we
        // become the OUTERMOST handler. Other extensions that wrap wc/wildcard in OnInit
        // resolve the name via GetBestInList on the raw data; our `name[query]` syntax fails that match, so
        // if they ran outermost they would drop the tag instead of delegating to us. Being outermost, we
        // claim our own datasets (brackets and all) and delegate everything else down the chain.
        WildcardHandler.Initialize();
    }

    public override void OnShutdown()
    {
        DatasetManager.Shutdown();
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
            DatasetManager.Enabled = settings.Value<bool?>("enabled") ?? false;
            DatasetManager.DatasetsFolder = settings.Value<string>("datasetsFolder") ?? "";
            DatasetManager.SetPromptColumns(ReadPromptColumns(settings["promptColumns"] as JObject));
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
            JObject settings = new()
            {
                ["enabled"] = DatasetManager.Enabled,
                ["datasetsFolder"] = DatasetManager.DatasetsFolder,
                ["promptColumns"] = promptColumns,
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
    #endregion

    #region API endpoints
    private static JObject BuildSettingsResponse()
    {
        JArray datasets = [];
        foreach (DatasetInfo info in DatasetManager.GetDatasetsInfo())
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
                ["rowCount"] = info.RowCount,
                ["error"] = info.Error,
            });
        }
        return new JObject
        {
            ["success"] = true,
            ["enabled"] = DatasetManager.Enabled,
            ["datasetsFolder"] = DatasetManager.DatasetsFolder,
            ["active"] = DatasetManager.IsActive,
            ["count"] = DatasetManager.Count,
            ["datasets"] = datasets,
        };
    }

    public Task<JObject> QuarryGetSettings(Session session)
    {
        return Task.FromResult(BuildSettingsResponse());
    }

    public Task<JObject> QuarrySaveSettings(Session session, bool enabled, string datasetsFolder, string promptColumnsJson)
    {
        try
        {
            DatasetManager.Enabled = enabled;
            DatasetManager.DatasetsFolder = datasetsFolder ?? "";
            JObject parsed = string.IsNullOrWhiteSpace(promptColumnsJson) ? [] : JObject.Parse(promptColumnsJson);
            DatasetManager.SetPromptColumns(ReadPromptColumns(parsed));
            DatasetManager.SyncPlaceholders();
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
        JObject response = BuildSettingsResponse();
        response["message"] = message;
        response["count"] = count;
        return Task.FromResult(response);
    }

    public Task<JObject> QuarryPreviewDataset(Session session, string dataset, int limit = 100)
    {
        int clamped = Math.Clamp(limit <= 0 ? 100 : limit, 1, 1000);
        (bool success, List<string> columns, List<List<string>> rows, string error) = DatasetManager.PreviewDataset(dataset, clamped);
        if (!success)
        {
            return Task.FromResult(new JObject { ["success"] = false, ["error"] = error });
        }
        JArray columnsArr = [];
        foreach (string column in columns)
        {
            columnsArr.Add(column);
        }
        JArray rowsArr = [];
        foreach (List<string> row in rows)
        {
            JArray rowArr = [];
            foreach (string cell in row)
            {
                rowArr.Add(cell);
            }
            rowsArr.Add(rowArr);
        }
        return Task.FromResult(new JObject
        {
            ["success"] = true,
            ["dataset"] = dataset,
            ["columns"] = columnsArr,
            ["rows"] = rowsArr,
        });
    }
    #endregion
}
