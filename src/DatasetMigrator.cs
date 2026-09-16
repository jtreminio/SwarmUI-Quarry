using System.IO;
using FreneticUtilities.FreneticExtensions;
using SwarmUI.Utils;

namespace Quarry;

public static class DatasetMigrator
{
    private const string MarkerName = ".quarry-nl-tags-migrated";

    // Run on every sync: users may install an older collection after their first upgrade.
    public static int RenameKnownDatasets(string folder, Action beforeMove = null)
    {
        string[] paths = [.. DatasetScanner.Enumerate(folder)];
        HashSet<string> names = new(paths.Select(path => DatasetNaming.ToName(Path.GetRelativePath(folder, path))), StringComparer.OrdinalIgnoreCase);
        int moved = 0;
        foreach (string path in paths)
        {
            string oldName = DatasetNaming.ToName(Path.GetRelativePath(folder, path));
            string newName = DatasetCatalog.CanonicalName(oldName);
            if (string.Equals(oldName, newName, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            string destination = Path.Combine(folder, newName + Path.GetExtension(path));
            if (names.Contains(newName) || File.Exists(destination) || Directory.Exists(destination))
            {
                Logs.Warning($"Quarry: cannot rename '{oldName}' to '{newName}' — destination already exists; keeping both copies.");
                continue;
            }
            try
            {
                beforeMove?.Invoke();
                beforeMove = null;
                Directory.CreateDirectory(Path.GetDirectoryName(destination));
                if (Directory.Exists(path))
                {
                    Directory.Move(path, destination);
                }
                else
                {
                    File.Move(path, destination);
                }
                names.Add(newName);
                DatasetCache.Rename(oldName.ToLowerFast(), newName.ToLowerFast());
                moved++;
                Logs.Info($"Quarry: renamed dataset '{oldName}' -> '{newName}'.");
            }
            catch (Exception ex)
            {
                Logs.Warning($"Quarry: failed to rename '{oldName}' -> '{newName}': {ex.Message}");
            }
        }
        return moved;
    }

    public static void RunInBackground()
    {
        if (!DatasetManager.IsActive)
        {
            return;
        }
        Utilities.RunCheckedTask(RunAsync, "Quarry dataset relocation");
    }

    public static async Task RunAsync()
    {
        string folder = DatasetManager.DatasetsFolder;
        if (string.IsNullOrWhiteSpace(folder) || !Directory.Exists(folder))
        {
            return;
        }
        string marker = Path.Combine(folder, MarkerName);
        if (File.Exists(marker))
        {
            return;
        }
        List<DatasetEntry> rootDatasets = [.. DatasetManager.AllDatasets.Where(e => !e.Name.Contains('/'))];
        if (rootDatasets.Count == 0)
        {
            WriteMarker(marker);
            return;
        }
        List<RemoteDataset> remote;
        try
        {
            remote = await DatasetDownloader.ListAvailableAsync(token: null);
        }
        catch (Exception ex)
        {
            Logs.Debug($"Quarry: skipping dataset relocation, remote list unavailable: {ex.Message}");
            return;
        }
        if (!remote.Any(r => r.Name.Contains('/')))
        {
            Logs.Debug("Quarry: skipping dataset relocation, remote has no subdirectory datasets yet.");
            return;
        }
        HashSet<string> remoteRootNames = new(remote.Where(r => !r.Name.Contains('/')).Select(r => r.Name), StringComparer.OrdinalIgnoreCase);
        List<string> remoteNames = [.. remote.Select(r => r.Name)];
        int moved = 0;
        foreach (DatasetEntry entry in rootDatasets)
        {
            if (remoteRootNames.Contains(entry.Name))
            {
                continue;
            }
            string target = DatasetNameMatching.MatchMissingDirectory(entry.Name, remoteNames);
            if (target is not null && TryRelocate(entry, target, folder))
            {
                moved++;
            }
        }
        if (moved > 0)
        {
            DatasetManager.Refresh();
            Logs.Info($"Quarry: relocated {moved} dataset(s) into their new subdirectory after the repository restructure.");
        }
        WriteMarker(marker);
    }

    private static bool TryRelocate(DatasetEntry entry, string targetName, string folder)
    {
        string targetDir = targetName[..targetName.LastIndexOf('/')];
        string destDir = Path.Combine(folder, targetDir);
        string dest = Path.Combine(destDir, Path.GetFileName(entry.Path));
        string newName = $"{targetDir}/{entry.Name}";
        try
        {
            if (File.Exists(dest) || Directory.Exists(dest))
            {
                Logs.Warning($"Quarry: cannot relocate '{entry.Name}' to '{newName}' — destination already exists.");
                return false;
            }
            Directory.CreateDirectory(destDir);
            if (Directory.Exists(entry.Path))
            {
                Directory.Move(entry.Path, dest);
            }
            else
            {
                File.Move(entry.Path, dest);
            }
            DatasetCache.Rename(entry.Name.ToLowerFast(), newName.ToLowerFast());
            Logs.Info($"Quarry: relocated dataset '{entry.Name}' -> '{newName}'.");
            return true;
        }
        catch (Exception ex)
        {
            Logs.Warning($"Quarry: failed to relocate '{entry.Name}' -> '{newName}': {ex.Message}");
            return false;
        }
    }

    private static void WriteMarker(string marker)
    {
        try
        {
            File.WriteAllText(marker, "Quarry relocated root-level datasets into nl/tags subdirectories. Delete this file to re-run the check.\n");
        }
        catch (Exception ex)
        {
            Logs.Debug($"Quarry: could not write relocation marker '{marker}': {ex.Message}");
        }
    }
}
