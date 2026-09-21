using System.Globalization;
using System.IO;
using Newtonsoft.Json.Linq;

namespace Quarry;

public sealed record DatasetRepairIssue(string Dataset, string Error);
public sealed record DatasetRepairResult(int Checked, int Repaired, IReadOnlyList<DatasetRepairIssue> Issues);

/// <summary>Recover mixed downloaded snapshots using only their recorded local manifests.</summary>
internal static class DatasetRepair
{
    internal static DatasetRepairResult RepairAll(string root)
    {
        if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
        {
            throw new InvalidDataException("Save a valid datasets folder before repairing datasets.");
        }
        int checkedCount = 0, repaired = 0;
        List<DatasetRepairIssue> issues = [];
        foreach (string path in Enumerate(root))
        {
            checkedCount++;
            try
            {
                if (RepairOne(path))
                {
                    repaired++;
                }
            }
            catch (Exception ex)
            {
                issues.Add(new(DatasetNaming.ToName(Path.GetRelativePath(root, path)), ex.Message));
            }
        }
        return new(checkedCount, repaired, issues);
    }

    private static IEnumerable<string> Enumerate(string root)
    {
        foreach (string path in Directory.EnumerateDirectories(root))
        {
            if (Path.GetFileName(path).StartsWith('.') || IsLink(path))
            {
                continue;
            }
            if (path.EndsWith(".lance", StringComparison.OrdinalIgnoreCase))
            {
                yield return path;
            }
            else
            {
                foreach (string dataset in Enumerate(path))
                {
                    yield return dataset;
                }
            }
        }
    }

    private static bool IsLink(string path) => (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;

    internal static bool RepairOne(string path, Action<string> validate = null)
    {
        string descriptorPath = Path.Combine(path, CasingStorage.DescriptorName);
        string versions = Path.Combine(path, "_versions");
        if (!File.Exists(descriptorPath) || !Directory.Exists(versions))
        {
            return false;
        }
        if (IsLink(path) || IsLink(descriptorPath) || IsLink(versions))
        {
            throw new InvalidDataException("Repair does not follow linked dataset metadata.");
        }
        string[] manifests = Directory.GetFiles(versions, "*.manifest");
        if (manifests.Length < 2)
        {
            return false;
        }
        JObject descriptor = JObject.Parse(File.ReadAllText(descriptorPath));
        if (descriptor.Value<int?>("version") is not (1 or 2)
            || descriptor["columns"] is not JObject columns
            || columns.Count == 0)
        {
            return false; // Only Quarry's casing snapshots are repair candidates.
        }
        validate ??= Validate;
        try
        {
            validate(path);
            return false; // Never roll a readable dataset back to an older version.
        }
        catch (InvalidDataException)
        {
            // The casing descriptor cannot be used with the selected manifest.
        }

        string current = ExpectedManifest(descriptor, manifests);
        if (current is null)
        {
            throw new InvalidDataException("The recorded Quarry version is missing or ambiguous. No files changed; this dataset needs a fresh download.");
        }
        string hint = Path.Combine(versions, "latest_version_hint.json");
        string[] displaced = [.. manifests.Where(file => file != current), .. File.Exists(hint) ? new[] { hint } : []];
        if (manifests.Any(IsLink) || displaced.Any(IsLink))
        {
            throw new InvalidDataException("Repair does not follow linked dataset metadata.");
        }
        // Preserve every displaced byte. Backups are hidden and never scanned as datasets.
        string backup = Path.Combine(path, ".quarry-repair-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(backup);
        List<string> moved = [];
        try
        {
            foreach (string file in displaced)
            {
                File.Move(file, Path.Combine(backup, Path.GetFileName(file)));
                moved.Add(file);
            }
            validate(path);
            return true;
        }
        catch (Exception error)
        {
            List<Exception> failures = [];
            foreach (string file in moved.AsEnumerable().Reverse())
            {
                try
                {
                    File.Move(Path.Combine(backup, Path.GetFileName(file)), file);
                }
                catch (Exception restoreError)
                {
                    failures.Add(restoreError);
                }
            }
            if (failures.Count > 0)
            {
                throw new IOException($"Repair failed and some metadata could not be restored. Keep the backup at {backup}. {error.Message}",
                    new AggregateException(failures.Prepend(error)));
            }
            throw new InvalidDataException($"Repair could not verify the recorded version; original metadata restored. {error.Message}", error);
        }
    }

    private static string ExpectedManifest(JObject descriptor, string[] manifests)
    {
        if (descriptor.Value<int?>("version") == 2)
        {
            string relative = descriptor["snapshot"]?.Value<string>("manifest");
            return manifests.SingleOrDefault(file => "_versions/" + Path.GetFileName(file) == relative);
        }
        JToken version = descriptor["optimized"]?["lance_version"];
        if (descriptor["optimized"]?.Value<int?>("version") != 1 || version?.Type != JTokenType.Integer
            || !ulong.TryParse(version.ToString(), out ulong number) || number == 0)
        {
            return null;
        }
        string v1 = number.ToString(CultureInfo.InvariantCulture) + ".manifest";
        string v2 = (ulong.MaxValue - number).ToString("D20", CultureInfo.InvariantCulture) + ".manifest";
        string[] matches = [.. manifests.Where(file => Path.GetFileName(file) == v1 || Path.GetFileName(file) == v2)];
        return matches.Length == 1 ? matches[0] : null;
    }

    private static void Validate(string path)
    {
        // A new reader avoids retaining the previously selected manifest or indexes.
        using DuckDbQueryBackend backend = new();
        _ = backend.GetSchema(path);
        _ = backend.CountRows(path, SqlFilter.None);
        _ = backend.GetSampleRows(path, 3);
    }
}
