using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using FreneticUtilities.FreneticToolkit;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SwarmUI.Core;
using SwarmUI.Utils;

namespace Quarry;

public sealed record RemoteDataset(string Name, string RepoPath, long SizeBytes, int FileCount, bool Installed,
    string ContentHash = null, string Revision = null, bool UpdateAvailable = false)
{
    public bool HasDescriptor { get; init; }
}

public sealed record RemoteFile(string RepoPath, string RelativePath, long SizeBytes);

public static class DatasetDownloader
{
    public const string RepoId = "jtreminio/prompt-dataset";
    public static string RepoUrl => $"https://huggingface.co/datasets/{RepoId}";
    private const string ApiBase = "https://huggingface.co/api/datasets/" + RepoId;
    private static readonly AsciiMatcher TokenCleaner = new(AsciiMatcher.BothCaseLetters + AsciiMatcher.Digits + "-_.");
    private static readonly SemaphoreSlim ListLock = new(1, 1);
    private static List<RemoteDataset> _listCache;
    private static DateTime _listCacheUtc;
    private static readonly TimeSpan ListTtl = TimeSpan.FromMinutes(5);

    public static async Task<List<RemoteDataset>> ListAvailableAsync(string token, bool forceRefresh = false)
    {
        List<RemoteDataset> remote = await GetRemoteListAsync(token, forceRefresh);
        List<RemoteDataset> result = [];
        foreach (RemoteDataset dataset in remote)
        {
            string path = InstalledPath(dataset.RepoPath);
            bool updateAvailable = path is not null && DatasetDownloadHash.HasUpdate(path, dataset.ContentHash);
            result.Add(dataset with { Installed = path is not null, UpdateAvailable = updateAvailable });
        }
        return result;
    }

    private static async Task<List<RemoteDataset>> GetRemoteListAsync(string token, bool forceRefresh)
    {
        await ListLock.WaitAsync(Program.GlobalProgramCancel);
        try
        {
            if (!forceRefresh && _listCache is not null && DateTime.UtcNow - _listCacheUtc < ListTtl)
            {
                return _listCache;
            }
            JObject info = JObject.Parse(await FetchJsonAsync(ApiBase + "/revision/main", token));
            string revision = info.Value<string>("sha");
            if (string.IsNullOrEmpty(revision))
            {
                throw new SwarmReadableErrorException("HuggingFace did not return the collection revision.");
            }
            JArray tree = await FetchTreeAsync($"{ApiBase}/tree/{Uri.EscapeDataString(revision)}?recursive=true", token);
            RemoteDataset[] datasets = [.. ParseAvailableDatasets(tree, _ => false).Select(d => d with { Revision = revision })];
            await Parallel.ForEachAsync(Enumerable.Range(0, datasets.Length), new ParallelOptions
            {
                MaxDegreeOfParallelism = 4,
                CancellationToken = Program.GlobalProgramCancel,
            }, async (index, cancel) =>
            {
                RemoteDataset dataset = datasets[index];
                if (!dataset.HasDescriptor)
                {
                    return;
                }
                try
                {
                    string json = await FetchJsonAsync(ResolveUrl(dataset.RepoPath + "/" + CasingStorage.DescriptorName, revision), token);
                    datasets[index] = dataset with { ContentHash = DatasetDownloadHash.Parse(json) };
                }
                catch (Exception ex) when (ex is HttpRequestException or JsonException)
                {
                    Logs.Debug($"Quarry: could not check published hash for '{dataset.Name}': {ex.Message}");
                }
            });
            _listCache = [.. datasets];
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
        Dictionary<string, (long Size, int Count, bool HasDescriptor)> byFolder = new(StringComparer.Ordinal);
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
            string folder = DatasetFolderOf(path);
            if (folder is null)
            {
                continue;
            }
            byFolder.TryGetValue(folder, out var current);
            byFolder[folder] = (current.Size + (entry.Value<long?>("size") ?? 0), current.Count + 1,
                current.HasDescriptor || path == folder + "/" + CasingStorage.DescriptorName);
        }
        List<RemoteDataset> result = [];
        foreach (KeyValuePair<string, (long Size, int Count, bool HasDescriptor)> kv in byFolder)
        {
            string name = DatasetCatalog.CanonicalName(DatasetNaming.ToName(kv.Key));
            string localPath = DatasetCatalog.LocalPath(kv.Key);
            result.Add(new RemoteDataset(name, kv.Key, kv.Value.Size, kv.Value.Count,
                isInstalled(kv.Key) || (localPath != kv.Key && isInstalled(localPath)))
            {
                HasDescriptor = kv.Value.HasDescriptor,
            });
        }
        // The collection may publish both legacy and canonical names during the transition.
        result = [.. result.GroupBy(d => d.Name, StringComparer.OrdinalIgnoreCase).Select(group =>
        {
            RemoteDataset preferred = group.OrderBy(d => d.RepoPath != DatasetCatalog.LocalPath(d.RepoPath))
                .ThenBy(d => d.RepoPath, StringComparer.Ordinal).First();
            return preferred with { Installed = group.Any(d => d.Installed) };
        })];
        result.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
        return result;
    }

    public static string DatasetFolderOf(string path)
    {
        string[] segments = path.Split('/');
        for (int i = 0; i < segments.Length - 1; i++)
        {
            string segment = segments[i];
            if (segment.Length == 0 || segment[0] == '.')
            {
                return null;
            }
            if (segment.EndsWith(".lance", StringComparison.OrdinalIgnoreCase))
            {
                return string.Join('/', segments[..(i + 1)]);
            }
        }
        return null;
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

    private static HttpRequestMessage CreateRequest(string url, string token)
    {
        HttpRequestMessage request = new(HttpMethod.Get, url);
        request.Headers.UserAgent.ParseAdd("SwarmUI-Quarry");
        string bearer = CleanToken(token);
        if (!string.IsNullOrEmpty(bearer))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        }
        return request;
    }

    private static async Task<string> FetchJsonAsync(string url, string token)
    {
        using HttpRequestMessage request = CreateRequest(url, token);
        using HttpResponseMessage response = await Utilities.UtilWebClient.SendAsync(request, Program.GlobalProgramCancel);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync(Program.GlobalProgramCancel);
    }

    private static async Task<JArray> FetchTreeAsync(string url, string token)
    {
        JArray all = [];
        string next = url;
        int guard = 0;
        while (next is not null && guard++ < 1000)
        {
            using HttpRequestMessage request = CreateRequest(next, token);
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
        if (next is not null)
        {
            throw new SwarmReadableErrorException("HuggingFace returned an incomplete dataset listing.");
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
    private static string ResolveUrl(string repoPath, string revision) => $"{RepoUrl}/resolve/{Uri.EscapeDataString(revision)}/{EncodeRepoPath(repoPath)}?download=true";

    private static string InstalledPath(string repoPath)
    {
        string folder = DatasetManager.DatasetsFolder;
        if (string.IsNullOrWhiteSpace(folder))
        {
            return null;
        }
        try
        {
            string canonicalPath = Path.Combine(folder, DatasetCatalog.LocalPath(repoPath));
            string originalPath = Path.Combine(folder, repoPath);
            return Directory.Exists(canonicalPath) ? canonicalPath : Directory.Exists(originalPath) ? originalPath : null;
        }
        catch
        {
            return null;
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
        string canonicalName = DatasetCatalog.CanonicalName(datasetName);
        RemoteDataset target = available.FirstOrDefault(d => string.Equals(d.Name, canonicalName, StringComparison.OrdinalIgnoreCase));
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
        string finalDir = Path.Combine(folder, DatasetCatalog.LocalPath(target.RepoPath));
        string parentDir = Path.GetDirectoryName(finalDir);
        string leaf = Path.GetFileName(finalDir);
        string tempDir = Path.Combine(parentDir, $".{leaf}.swarmdl-tmp");
        string trashDir = Path.Combine(parentDir, $".{leaf}.swarmdl-old");
        try
        {
            if (!redownload && Directory.Exists(finalDir))
            {
                SetState(id, s => { s.State = "done"; s.BytesDone = s.BytesTotal; s.FilesDone = s.FilesTotal; });
                return;
            }
            Directory.CreateDirectory(parentDir);
            List<RemoteFile> files = await ListDatasetFilesAsync(target.RepoPath, target.Revision, token);
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
                string url = ResolveUrl(file.RepoPath, target.Revision);
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
            cancel.ThrowIfCancellationRequested();
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

    private static async Task<List<RemoteFile>> ListDatasetFilesAsync(string repoPath, string revision, string token)
    {
        JArray tree = await FetchTreeAsync($"{ApiBase}/tree/{Uri.EscapeDataString(revision)}/{EncodeRepoPath(repoPath)}?recursive=true", token);
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
