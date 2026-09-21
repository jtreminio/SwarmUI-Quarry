using System.IO;
using System.IO.Compression;
using DuckDB.NET.Data;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Quarry.Tests;

public sealed class DatasetRepairTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "quarry-repair-tests-" + Guid.NewGuid().ToString("N"));
    private string Dataset => Path.Combine(_root, "sample.lance");
    private string Versions => Path.Combine(Dataset, "_versions");
    private string Descriptor => Path.Combine(Dataset, CasingStorage.DescriptorName);

    public DatasetRepairTests()
    {
        Directory.CreateDirectory(Versions);
        File.WriteAllText(Descriptor, """{"version":1,"columns":{"prompt":"prompt__case"},"optimized":{"version":1,"lance_version":2}}""");
        File.WriteAllText(Path.Combine(Versions, "18446744073709551613.manifest"), "current");
        File.WriteAllText(Path.Combine(Versions, "18446744073709551604.manifest"), "stale");
        File.WriteAllText(Path.Combine(Versions, "latest_version_hint.json"), "original hint");
    }

    private static void ValidateIsolated(string path)
    {
        if (Directory.GetFiles(Path.Combine(path, "_versions"), "*.manifest").Length != 1)
        {
            throw new InvalidDataException("Invalid casing columns for 'prompt'.");
        }
    }

    [Fact]
    public void RepairsOnlyMetadataAndKeepsRecoverableBackups()
    {
        Directory.CreateDirectory(Path.Combine(Dataset, "data"));
        string data = Path.Combine(Dataset, "data", "large.lance");
        File.WriteAllText(data, "unchanged data bytes");
        string before = File.ReadAllText(Descriptor);
        Assert.True(DatasetRepair.RepairOne(Dataset, ValidateIsolated));
        Assert.Equal("current", File.ReadAllText(Assert.Single(Directory.GetFiles(Versions, "*.manifest"))));
        string backup = Assert.Single(Directory.GetDirectories(Dataset, ".quarry-repair-*"));
        Assert.Equal("stale", File.ReadAllText(Path.Combine(backup, "18446744073709551604.manifest")));
        Assert.Equal("original hint", File.ReadAllText(Path.Combine(backup, "latest_version_hint.json")));
        Assert.Equal(before, File.ReadAllText(Descriptor));
        Assert.Equal("unchanged data bytes", File.ReadAllText(data));
        Assert.False(DatasetRepair.RepairOne(Dataset, ValidateIsolated));
    }

    [Fact]
    public void ReadableLaterVersionsAreNeverRolledBack()
    {
        Assert.False(DatasetRepair.RepairOne(Dataset, _ => { }));
        Assert.Equal(2, Directory.GetFiles(Versions, "*.manifest").Length);
        Assert.Empty(Directory.GetDirectories(Dataset, ".quarry-repair-*"));
    }

    [Fact]
    public void FailedValidationRestoresEveryManifestAndHint()
    {
        Dictionary<string, string> before = Directory.GetFiles(Versions).ToDictionary(Path.GetFileName, File.ReadAllText);
        InvalidDataException error = Assert.Throws<InvalidDataException>(() => DatasetRepair.RepairOne(Dataset,
            _ => throw new InvalidDataException("missing data file")));
        Assert.Contains("original metadata restored", error.Message);
        Assert.Equal(before.OrderBy(p => p.Key), Directory.GetFiles(Versions)
            .ToDictionary(Path.GetFileName, File.ReadAllText).OrderBy(p => p.Key));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("ambiguous")]
    [InlineData("unsupported")]
    public void CannotGuessTheRecordedManifest(string reason)
    {
        if (reason == "missing")
        {
            File.Move(Path.Combine(Versions, "18446744073709551613.manifest"), Path.Combine(Versions, "3.manifest"));
        }
        else if (reason == "ambiguous")
        {
            File.WriteAllText(Path.Combine(Versions, "2.manifest"), "also claims version 2");
        }
        else
        {
            JObject metadata = JObject.Parse(File.ReadAllText(Descriptor));
            metadata["optimized"]["version"] = 99;
            File.WriteAllText(Descriptor, metadata.ToString());
        }
        Assert.Throws<InvalidDataException>(() => DatasetRepair.RepairOne(Dataset,
            _ => throw new InvalidDataException("Invalid casing columns")));
        Assert.Empty(Directory.GetDirectories(Dataset, ".quarry-repair-*"));
    }

    [Fact]
    public void SupportsLegacyManifestNames()
    {
        File.Move(Path.Combine(Versions, "18446744073709551613.manifest"), Path.Combine(Versions, "2.manifest"));
        Assert.True(DatasetRepair.RepairOne(Dataset, ValidateIsolated));
        Assert.Equal("2.manifest", Path.GetFileName(Assert.Single(Directory.GetFiles(Versions, "*.manifest"))));
    }

    [Fact]
    public void SkipsUnmarkedDatasets()
    {
        File.Delete(Descriptor);
        Assert.False(DatasetRepair.RepairOne(Dataset, _ => throw new Exception("Should not validate")));
        Assert.Equal(2, Directory.GetFiles(Versions, "*.manifest").Length);
    }

    [Fact]
    public void VersionTwoUsesAndVerifiesTheRecordedSnapshot()
    {
        string extracted = Path.Combine(_root, "v2");
        ZipFile.ExtractToDirectory(Path.Combine(AppContext.BaseDirectory, "Fixtures", "lance-structured-v2.zip"), extracted);
        string dataset = Path.Combine(extracted, "portraits.lance");
        string versions = Path.Combine(dataset, "_versions");
        string original = Assert.Single(Directory.GetFiles(versions, "*.manifest"));
        File.Copy(original, Path.Combine(versions, "999.manifest"));
        Assert.True(DatasetRepair.RepairOne(dataset));
        Assert.True(CasingStorage.LoadLayout(dataset).SnapshotMatches);
        Assert.Equal(original, Assert.Single(Directory.GetFiles(versions, "*.manifest")));
    }

    [Fact]
    public void VersionTwoSnapshotHashMismatchRollsBack()
    {
        string extracted = Path.Combine(_root, "bad-v2");
        ZipFile.ExtractToDirectory(Path.Combine(AppContext.BaseDirectory, "Fixtures", "lance-structured-v2.zip"), extracted);
        string dataset = Path.Combine(extracted, "portraits.lance");
        string versions = Path.Combine(dataset, "_versions");
        string original = Assert.Single(Directory.GetFiles(versions, "*.manifest"));
        File.Copy(original, Path.Combine(versions, "999.manifest"));
        string descriptor = Path.Combine(dataset, CasingStorage.DescriptorName);
        JObject metadata = JObject.Parse(File.ReadAllText(descriptor));
        metadata["snapshot"]["sha256"] = new string('0', 64);
        File.WriteAllText(descriptor, metadata.ToString());

        Assert.Contains("original metadata restored", Assert.Throws<InvalidDataException>(
            () => DatasetRepair.RepairOne(dataset)).Message);
        Assert.Equal(2, Directory.GetFiles(versions, "*.manifest").Length);
    }

    [Fact]
    public async Task MaintenanceWaitsForPooledReadersAndReleasesLocksOnFailure()
    {
        using DuckDbQueryBackend backend = new();
        using ManualResetEventSlim reading = new(), finishRead = new(), maintenanceStarted = new();
        Task read = Task.Run(() => backend.RunPooled([_ =>
        {
            reading.Set();
            Assert.True(finishRead.Wait(TimeSpan.FromSeconds(10)));
        }], 1));
        Assert.True(reading.Wait(TimeSpan.FromSeconds(10)));
        Task repair = Task.Run(() =>
        {
            maintenanceStarted.Set();
            Assert.Throws<InvalidDataException>(() => backend.WithMaintenance<int>(
                () => throw new InvalidDataException("repair failed")));
        });
        try
        {
            Assert.True(maintenanceStarted.Wait(TimeSpan.FromSeconds(10)));
            Assert.False(repair.Wait(100));
        }
        finally
        {
            finishRead.Set();
        }
        await Task.WhenAll(read, repair).WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(42, backend.WithMaintenance(() => 42));
        backend.RunPooled([_ => { }], 1);
    }

    [Fact]
    public async Task RepairEndpointRejectsConcurrentDatasetMutation()
    {
        Assert.True(DatasetManager.MutationGate.Wait(0));
        try
        {
            JObject response = await new QuarryExtension().QuarryRepairDatasets(null);
            Assert.False(response.Value<bool>("success"));
            Assert.Contains("already running", response.Value<string>("error"));
        }
        finally
        {
            DatasetManager.MutationGate.Release();
        }
    }

    [Fact]
    public void RealMixedLanceVersionsRecoverOriginalCasing()
    {
        string currentRoot = Path.Combine(_root, "current"), legacyRoot = Path.Combine(_root, "legacy");
        string current = CreateDataset(currentRoot, true, 1);
        string legacy = CreateDataset(legacyRoot, false, 5);
        string currentVersions = Path.Combine(current, "_versions");
        ulong Version(string file)
        {
            string name = Path.GetFileNameWithoutExtension(file);
            ulong number = ulong.Parse(name);
            return name.Length == 20 ? ulong.MaxValue - number : number;
        }
        string latestCurrent = Directory.GetFiles(currentVersions, "*.manifest").MaxBy(Version);
        // Keep only the completed snapshot, like Quarry's optimizer does.
        foreach (string file in Directory.GetFiles(currentVersions, "*.manifest").Where(file => file != latestCurrent))
        {
            File.Delete(file);
        }
        File.WriteAllText(Path.Combine(current, CasingStorage.DescriptorName), new JObject
        {
            ["version"] = 1, ["columns"] = new JObject { ["prompt"] = "prompt__case" },
            ["optimized"] = new JObject { ["version"] = 1, ["lance_version"] = Version(latestCurrent) },
        }.ToString());
        string oldManifest = Directory.GetFiles(Path.Combine(legacy, "_versions"), "*.manifest").MaxBy(Version);
        Assert.True(Version(oldManifest) > Version(latestCurrent));
        File.Copy(oldManifest, Path.Combine(currentVersions, Path.GetFileName(oldManifest)));
        using (DuckDbQueryBackend backend = new())
        {
            Assert.Throws<InvalidDataException>(() => backend.GetSchema(current));
        }

        Assert.True(DatasetRepair.RepairOne(current));

        using DuckDbQueryBackend repaired = new();
        Assert.Equal("Blue Cat", repaired.GetPromptAt(current, ["prompt"], SqlFilter.None, 0));
        Assert.Equal(1, repaired.CountRows(current, SqlFilter.None));
        Assert.False(DatasetRepair.RepairOne(current));
    }

    private static string CreateDataset(string root, bool casing, int inserts)
    {
        Directory.CreateDirectory(root);
        using DuckDBConnection connection = new("DataSource=:memory:");
        connection.Open();
        using DuckDBCommand command = connection.CreateCommand();
        command.CommandText = $"INSTALL lance; LOAD lance; ATTACH {SqlText.QuoteLiteral(root)} AS sampledb (TYPE lance);";
        command.ExecuteNonQuery();
        command.CommandText = "CREATE TABLE sampledb.main.sample (prompt VARCHAR, "
            + (casing ? "prompt__case BLOB" : "prompt__lc VARCHAR") + ");";
        command.ExecuteNonQuery();
        for (int i = 0; i < inserts; i++)
        {
            command.CommandText = "INSERT INTO sampledb.main.sample VALUES "
                + (casing ? "('blue cat', from_hex('530005'))" : "('Old prompt', 'old prompt')");
            command.ExecuteNonQuery();
        }
        command.CommandText = "DETACH sampledb;";
        command.ExecuteNonQuery();
        return Path.Combine(root, "sample.lance");
    }

    public void Dispose() => Directory.Delete(_root, true);
}
