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

    /// <summary>Serializes requirement installs so two rapid clicks can't launch overlapping ~235 MB downloads.</summary>
    private static readonly SemaphoreSlim InstallLock = new(1, 1);

    public override void OnPreInit()
    {
        ScriptFiles.Add("Assets/quarry.js");
        StyleSheetFiles.Add("Assets/quarry.css");
    }

    public override void OnInit()
    {
        LoadSettings();
        ApplyDefaultDatasetsFolder();
        DatasetManager.Initialize();
        // Register our own <q:...> prompt tag. It's exclusively ours (no piggybacking on wc/wildcard), so there's
        // no init-order/chaining concern — a plain OnInit registration is enough.
        WildcardHandler.Initialize();

        API.RegisterAPICall(QuarryGetSettings, false, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarrySaveSettings, true, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryRefresh, true, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryPreviewDataset, false, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryResolveReferences, false, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(QuarryInstallRequirements, true, Permissions.InstallFeatures);

        string status = DatasetManager.IsActive ? $"enabled, folder: {DatasetManager.DatasetsFolder}" : "disabled";
        Logs.Info($"Quarry extension initialized ({status}).");
    }

    /// <summary>When no datasets folder is configured (fresh install, or the user cleared it), default it to a
    /// <c>Quarry</c> directory beside SwarmUI's Wildcards folder — honoring any user override of the Wildcards
    /// path, since <see cref="WildcardsHelper.Folder"/> reads the live setting (core initializes it before
    /// extensions' OnInit runs). The folder is created best-effort so it's ready to drop datasets into.</summary>
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
                ["enabled"] = DatasetManager.Enabled,
                ["datasetsFolder"] = DatasetManager.DatasetsFolder,
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
        // Reading dataset schemas/counts needs the lance extension; until it's installed the UI shows only the
        // install gate, so skip the (otherwise failing, wasteful) enumeration entirely.
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
                    ["configuredTagColumns"] = new JArray(info.ConfiguredTagColumns),
                    ["rowCount"] = info.RowCount,
                    ["error"] = info.Error,
                });
            }
        }
        return new JObject
        {
            ["success"] = true,
            ["enabled"] = DatasetManager.Enabled,
            ["datasetsFolder"] = DatasetManager.DatasetsFolder,
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

    public Task<JObject> QuarrySaveSettings(Session session, bool enabled, string datasetsFolder, string promptColumnsJson, string tagColumnsJson)
    {
        try
        {
            DatasetManager.Enabled = enabled;
            DatasetManager.DatasetsFolder = datasetsFolder ?? "";
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
        // Warm the cache (schema + row count + preview for every changed/uncached dataset) so the table can
        // show counts now and later previews are instant. After warming, the counts come from the cache, so
        // asking for them here is cheap (no fresh scans).
        int warmed = DatasetManager.WarmAll();
        JObject response = BuildSettingsResponse(includeRowCounts: true);
        response["message"] = warmed > 0 ? $"{message} Warmed {warmed} dataset(s)." : message;
        response["count"] = count;
        return Task.FromResult(response);
    }

    public Task<JObject> QuarryPreviewDataset(Session session, string dataset, int limit = DatasetManager.DefaultPreviewLimit)
    {
        int clamped = Math.Clamp(limit <= 0 ? DatasetManager.DefaultPreviewLimit : limit, 1, 1000);
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
        JObject response = new()
        {
            ["success"] = true,
            ["dataset"] = dataset,
            ["columns"] = columnsArr,
            ["rows"] = rowsArr,
        };
        // The usable-pick row count is loaded lazily here (on preview) rather than eagerly for every dataset
        // at startup. Best-effort: a count failure must not hide the sample rows we already read.
        (bool countSuccess, long? rowCount, _) = DatasetManager.GetUsableRowCount(dataset);
        if (countSuccess && rowCount is not null)
        {
            response["rowCount"] = rowCount.Value;
        }
        return Task.FromResult(response);
    }

    /// <summary>Given the current prompt text, returns the wildcard names of the Quarry datasets it references,
    /// so the settings UI can flag in-use files. Uses the same resolution as real expansion (comma lists, globs,
    /// fuzzy match); filters in the reference are ignored.</summary>
    public Task<JObject> QuarryResolveReferences(Session session, string prompt)
    {
        JArray names = [];
        foreach (string name in WildcardHandler.ResolveReferencedDatasetNames(prompt ?? ""))
        {
            names.Add(name);
        }
        return Task.FromResult(new JObject
        {
            ["success"] = true,
            ["names"] = names,
        });
    }

    /// <summary>Installs Quarry's runtime requirement (the DuckDB <c>lance</c> extension) — a one-time ~235 MB
    /// download from the official DuckDB extension repo. Long-running, so it runs off the request thread and is
    /// serialized by <see cref="InstallLock"/> against overlapping installs. On success the datasets are
    /// re-synced so they're readable immediately; the frontend then reloads settings to reveal the panel.</summary>
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
    #endregion
}
