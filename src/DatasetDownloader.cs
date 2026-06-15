using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using FreneticUtilities.FreneticToolkit;
using Newtonsoft.Json.Linq;
using SwarmUI.Core;
using SwarmUI.Utils;

namespace Quarry;

public sealed record RemoteDataset(string Name, string RepoPath, long SizeBytes, int FileCount, bool Installed);

public sealed record RemoteFile(string RepoPath, string RelativePath, long SizeBytes);

public static class DatasetDownloader
{
    public const string RepoId = "jtreminio/prompt-dataset";
    public static string RepoUrl => $"https://huggingface.co/datasets/{RepoId}";
    private const string TreeApiBase = "https://huggingface.co/api/datasets/" + RepoId + "/tree/main";
    private const string ResolveBase = "https://huggingface.co/datasets/" + RepoId + "/resolve/main";
    private static readonly AsciiMatcher TokenCleaner = new(AsciiMatcher.BothCaseLetters + AsciiMatcher.Digits + "-_.");
    private static readonly SemaphoreSlim ListLock = new(1, 1);
    private static List<RemoteDataset> _listCache;
    private static DateTime _listCacheUtc;
    private static readonly TimeSpan ListTtl = TimeSpan.FromMinutes(5);

    public static async Task<List<RemoteDataset>> ListAvailableAsync(string token)
    {
        List<RemoteDataset> remote = await GetRemoteListAsync(token);
        return [.. remote.Select(d => d with { Installed = IsInstalled(d.RepoPath) })];
    }

    private static async Task<List<RemoteDataset>> GetRemoteListAsync(string token)
    {
        await ListLock.WaitAsync(Program.GlobalProgramCancel);
        try
        {
            if (_listCache is not null && DateTime.UtcNow - _listCacheUtc < ListTtl)
            {
                return _listCache;
            }
            JArray tree = await FetchTreeAsync($"{TreeApiBase}?recursive=true", token);
            _listCache = ParseAvailableDatasets(tree, _ => false);
            _listCacheUtc = DateTime.UtcNow;
            return _listCache;
        }
        finally
        {
            ListLock.Release();
        }
    }

    public static void InvalidateListCache() => _listCache = null;

    public static List<RemoteDataset> ParseAvailableDatasets(JArray tree, Func<string, bool> isInstalled)
    {
        Dictionary<string, (long Size, int Count)> byFolder = new(StringComparer.Ordinal);
        foreach (JToken entry in tree)
        {
            if (entry.Value<string>("type") != "file")
            {
                continue;
            }
            string path = entry.Value<string>("path");
            if (string.IsNullOrEmpty(path))
            {
                continue;
            }
            int slash = path.IndexOf('/');
            if (slash <= 0)
            {
                continue;
            }
            string folder = path[..slash];
            if (!folder.EndsWith(".lance", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            long size = entry.Value<long?>("size") ?? 0;
            (long Size, int Count) acc = byFolder.TryGetValue(folder, out (long Size, int Count) cur) ? cur : (0L, 0);
            byFolder[folder] = (acc.Size + size, acc.Count + 1);
        }
        List<RemoteDataset> result = [];
        foreach (KeyValuePair<string, (long Size, int Count)> kv in byFolder)
        {
            string name = WildcardNaming.ToWildcardName(kv.Key);
            result.Add(new RemoteDataset(name, kv.Key, kv.Value.Size, kv.Value.Count, isInstalled(kv.Key)));
        }
        result.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
        return result;
    }

    public static List<RemoteFile> ParseDatasetFiles(JArray tree, string repoPath)
    {
        string prefix = repoPath + "/";
        List<RemoteFile> files = [];
        foreach (JToken entry in tree)
        {
            if (entry.Value<string>("type") != "file")
            {
                continue;
            }
            string path = entry.Value<string>("path");
            if (string.IsNullOrEmpty(path) || !path.StartsWith(prefix, StringComparison.Ordinal))
            {
                continue;
            }
            files.Add(new RemoteFile(path, path[prefix.Length..], entry.Value<long?>("size") ?? 0));
        }
        return files;
    }

    private static async Task<JArray> FetchTreeAsync(string url, string token)
    {
        JArray all = [];
        string next = url;
        int guard = 0;
        while (next is not null && guard++ < 1000)
        {
            using HttpRequestMessage request = new(HttpMethod.Get, next);
            request.Headers.UserAgent.ParseAdd("SwarmUI-Quarry");
            string bearer = CleanToken(token);
            if (!string.IsNullOrEmpty(bearer))
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
            }
            using HttpResponseMessage response = await Utilities.UtilWebClient.SendAsync(request, Program.GlobalProgramCancel);
            if (!response.IsSuccessStatusCode)
            {
                throw new SwarmReadableErrorException($"HuggingFace API returned {(int)response.StatusCode} ({response.StatusCode}) listing the dataset collection.");
            }
            string body = await response.Content.ReadAsStringAsync(Program.GlobalProgramCancel);
            foreach (JToken token2 in JArray.Parse(body))
            {
                all.Add(token2);
            }
            next = ParseNextLink(response.Headers);
        }
        return all;
    }

    private static string ParseNextLink(HttpResponseHeaders headers)
    {
        if (!headers.TryGetValues("Link", out IEnumerable<string> values))
        {
            return null;
        }
        foreach (string header in values)
        {
            foreach (string part in header.Split(','))
            {
                if (!part.Contains("rel=\"next\""))
                {
                    continue;
                }
                int open = part.IndexOf('<');
                int close = part.IndexOf('>');
                if (open >= 0 && close > open)
                {
                    return part[(open + 1)..close];
                }
            }
        }
        return null;
    }

    private static string CleanToken(string token) => string.IsNullOrEmpty(token) ? "" : TokenCleaner.TrimToMatches(token);
    private static string EncodeRepoPath(string repoPath) => string.Join('/', repoPath.Split('/').Select(Uri.EscapeDataString));
    private static string ResolveUrl(string repoPath) => $"{ResolveBase}/{EncodeRepoPath(repoPath)}?download=true";

    private static bool IsInstalled(string repoPath)
    {
        string folder = DatasetManager.DatasetsFolder;
        if (string.IsNullOrWhiteSpace(folder))
        {
            return false;
        }
        try
        {
            return Directory.Exists(Path.Combine(folder, repoPath));
        }
        catch
        {
            return false;
        }
    }

    public sealed class DownloadStatus
    {
        public int Id { get; set; }
        public string Dataset { get; set; }
        public string State { get; set; } = "idle";
        public long BytesDone { get; set; }
        public long BytesTotal { get; set; }
        public int FilesDone { get; set; }
        public int FilesTotal { get; set; }
        public long PerSecond { get; set; }
        public string Error { get; set; }

        public bool Active => State is "starting" or "downloading" or "finalizing";

        public DownloadStatus Clone() => (DownloadStatus)MemberwiseClone();
    }

    private static readonly object StateLock = new();
    private static DownloadStatus _status = new();
    private static CancellationTokenSource _cancel;
    private static int _idCounter;

    public static DownloadStatus GetStatus()
    {
        lock (StateLock)
        {
            return _status.Clone();
        }
    }

    public static void Cancel()
    {
        lock (StateLock)
        {
            _cancel?.Cancel();
        }
    }

    public static async Task<(bool Ok, string Error, int Id)> StartDownloadAsync(string datasetName, bool redownload, string token)
    {
        string folder = DatasetManager.DatasetsFolder;
        if (string.IsNullOrWhiteSpace(folder))
        {
            return (false, "No Quarry datasets folder is configured. Set one and save first.", 0);
        }
        List<RemoteDataset> available;
        try
        {
            available = await ListAvailableAsync(token);
        }
        catch (Exception ex)
        {
            return (false, $"Could not reach HuggingFace: {ex.Message}", 0);
        }
        RemoteDataset target = available.FirstOrDefault(d => string.Equals(d.Name, datasetName, StringComparison.OrdinalIgnoreCase));
        if (target is null)
        {
            return (false, $"Unknown dataset '{datasetName}'.", 0);
        }
        CancellationTokenSource cts;
        int id;
        lock (StateLock)
        {
            if (_status.Active)
            {
                return (false, $"A download is already in progress ({_status.Dataset}).", 0);
            }
            id = ++_idCounter;
            _cancel = new CancellationTokenSource();
            cts = _cancel;
            _status = new DownloadStatus
            {
                Id = id,
                Dataset = target.Name,
                State = "starting",
                BytesTotal = target.SizeBytes,
                FilesTotal = target.FileCount,
            };
        }
        _ = Task.Run(() => RunDownloadAsync(target, redownload, token, id, cts.Token));
        return (true, null, id);
    }

    private static async Task RunDownloadAsync(RemoteDataset target, bool redownload, string token, int id, CancellationToken cancel)
    {
        string folder = DatasetManager.DatasetsFolder;
        string finalDir = Path.Combine(folder, target.RepoPath);
        string tempDir = Path.Combine(folder, $".{target.RepoPath}.swarmdl-tmp");
        string trashDir = Path.Combine(folder, $".{target.RepoPath}.swarmdl-old");
        try
        {
            if (!redownload && Directory.Exists(finalDir))
            {
                SetState(id, s => { s.State = "done"; s.BytesDone = s.BytesTotal; s.FilesDone = s.FilesTotal; });
                return;
            }
            Directory.CreateDirectory(folder);
            List<RemoteFile> files = await ListDatasetFilesAsync(target.RepoPath, token);
            if (files.Count == 0)
            {
                throw new SwarmReadableErrorException("HuggingFace returned no files for this dataset.");
            }
            long total = files.Sum(f => f.SizeBytes);
            SetState(id, s => { s.State = "downloading"; s.FilesTotal = files.Count; s.BytesTotal = total; });
            SafeDeleteDir(tempDir);
            Directory.CreateDirectory(tempDir);
            Dictionary<string, string> headers = [];
            string bearer = CleanToken(token);
            if (!string.IsNullOrEmpty(bearer))
            {
                headers["Authorization"] = $"Bearer {bearer}";
            }
            long completed = 0;
            int doneFiles = 0;
            foreach (RemoteFile file in files)
            {
                cancel.ThrowIfCancellationRequested();
                string dest = Path.Combine(tempDir, file.RelativePath.Replace('/', Path.DirectorySeparatorChar));
                string url = ResolveUrl(file.RepoPath);
                using CancellationTokenSource fileCancel = CancellationTokenSource.CreateLinkedTokenSource(cancel);
                long fileBase = completed;
                await Utilities.DownloadFile(url, dest, (progress, _, perSec) =>
                {
                    SetState(id, s => { s.BytesDone = fileBase + progress; s.PerSecond = perSec; });
                }, fileCancel, url, headers: headers);
                completed += file.SizeBytes;
                doneFiles++;
                SetState(id, s => { s.BytesDone = completed; s.FilesDone = doneFiles; s.PerSecond = 0; });
            }
            SetState(id, s => s.State = "finalizing");
            SafeDeleteDir(trashDir);
            bool hadOld = Directory.Exists(finalDir);
            if (hadOld)
            {
                Directory.Move(finalDir, trashDir);
            }
            try
            {
                Directory.Move(tempDir, finalDir);
            }
            catch
            {
                if (hadOld)
                {
                    Directory.Move(trashDir, finalDir); // restore the old copy on a failed swap
                }
                throw;
            }
            if (hadOld)
            {
                SafeDeleteDir(trashDir);
            }
            DatasetManager.Refresh();
            DatasetManager.WarmAll();
            InvalidateListCache();
            SetState(id, s => { s.State = "done"; s.BytesDone = total; s.FilesDone = files.Count; s.PerSecond = 0; });
            Logs.Info($"Quarry: downloaded dataset '{target.Name}' ({files.Count} file(s), {new MemoryNum(total)}).");
        }
        catch (OperationCanceledException)
        {
            SafeDeleteDir(tempDir);
            SetState(id, s => s.State = "cancelled");
            Logs.Info($"Quarry: dataset download '{target.Name}' cancelled.");
        }
        catch (Exception ex)
        {
            SafeDeleteDir(tempDir);
            SetState(id, s => { s.State = "error"; s.Error = ex.Message; });
            Logs.Error($"Quarry: dataset download '{target.Name}' failed: {ex.ReadableString()}");
        }
    }

    private static async Task<List<RemoteFile>> ListDatasetFilesAsync(string repoPath, string token)
    {
        JArray tree = await FetchTreeAsync($"{TreeApiBase}/{EncodeRepoPath(repoPath)}?recursive=true", token);
        return ParseDatasetFiles(tree, repoPath);
    }

    private static void SetState(int id, Action<DownloadStatus> mutate)
    {
        lock (StateLock)
        {
            if (_status.Id != id)
            {
                return;
            }
            mutate(_status);
        }
    }

    private static void SafeDeleteDir(string dir)
    {
        try
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, true);
            }
        }
        catch (Exception ex)
        {
            Logs.Debug($"Quarry: could not remove temp dir '{dir}': {ex.Message}");
        }
    }
}
