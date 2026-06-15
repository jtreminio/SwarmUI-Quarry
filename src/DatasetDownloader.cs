using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using FreneticUtilities.FreneticToolkit;
using Newtonsoft.Json.Linq;
using SwarmUI.Core;
using SwarmUI.Utils;

namespace Quarry;

/// <summary>One downloadable dataset on the official HuggingFace repo: its <see cref="Name"/> (the
/// <c>&lt;q:NAME&gt;</c> it becomes once installed), the in-repo <see cref="RepoPath"/> of its <c>*.lance</c>
/// folder (e.g. <c>Gustavosta.Stable-Diffusion-Prompts.lance</c>), the total <see cref="SizeBytes"/> and
/// <see cref="FileCount"/> of the folder's files, and whether it is already present locally.</summary>
public sealed record RemoteDataset(string Name, string RepoPath, long SizeBytes, int FileCount, bool Installed);

/// <summary>One file inside a remote dataset folder: its full in-repo <see cref="RepoPath"/>, the
/// <see cref="RelativePath"/> within the dataset folder (used as the on-disk sub-path), and its size.</summary>
public sealed record RemoteFile(string RepoPath, string RelativePath, long SizeBytes);

/// <summary>Downloads ready-made datasets from the official HuggingFace collection
/// (<see cref="RepoId"/>) into the configured Quarry datasets folder. Lists the available <c>*.lance</c>
/// datasets via the HF tree API (cached briefly), and downloads one at a time — every file of a dataset folder
/// into a hidden temp dir, then atomically swapped into place — using the caller's HuggingFace token when set
/// (the repo is public, so an absent token still works). Exposes a single live <see cref="DownloadStatus"/>
/// the UI polls for progress, plus a cancel hook. Pure parsing (<see cref="ParseAvailableDatasets"/>,
/// <see cref="ParseDatasetFiles"/>) is split out so it can be unit tested without the network.</summary>
public static class DatasetDownloader
{
    /// <summary>The official ready-made dataset collection, as documented in the README.</summary>
    public const string RepoId = "jtreminio/prompt-dataset";

    /// <summary>The dataset page, surfaced to the UI so it can link out to the full collection.</summary>
    public static string RepoUrl => $"https://huggingface.co/datasets/{RepoId}";

    /// <summary>HF tree API for the repo's main revision (append <c>?recursive=true</c>, or <c>/&lt;path&gt;</c>
    /// for a subtree). Returns a JSON array of <c>{type,path,size,...}</c> entries.</summary>
    private const string TreeApiBase = "https://huggingface.co/api/datasets/" + RepoId + "/tree/main";

    /// <summary>HF file-resolve base; <c>{ResolveBase}/&lt;in-repo path&gt;</c> downloads one file.</summary>
    private const string ResolveBase = "https://huggingface.co/datasets/" + RepoId + "/resolve/main";

    /// <summary>Characters allowed through from a stored HF token before it goes into an <c>Authorization</c>
    /// header — letters, digits, and the few token punctuation chars. Strips whitespace/control characters so a
    /// stray newline can't break or inject into the header (mirrors the intent of core's model-download path).</summary>
    private static readonly AsciiMatcher TokenCleaner = new(AsciiMatcher.BothCaseLetters + AsciiMatcher.Digits + "-_.");

    #region Available-list (HF tree) with short cache
    private static readonly SemaphoreSlim ListLock = new(1, 1);
    /// <summary>The parsed remote datasets from the last successful tree fetch (their <c>Installed</c> flag is
    /// recomputed fresh on every <see cref="ListAvailableAsync"/> call, so it is not relied on here).</summary>
    private static List<RemoteDataset> _listCache;
    private static DateTime _listCacheUtc;
    private static readonly TimeSpan ListTtl = TimeSpan.FromMinutes(5);

    /// <summary>Returns the available datasets, each flagged with whether it is currently installed locally.
    /// The remote listing is cached for <see cref="ListTtl"/> to avoid re-hitting the HF API every time the
    /// modal opens; the (cheap, local) installed check is always recomputed so a just-finished download shows
    /// immediately. <paramref name="token"/> is optional — the repo is public — but is sent when present to ease
    /// rate limits.</summary>
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
            // installed=false here; ListAvailableAsync re-evaluates it per call against the live folder.
            _listCache = ParseAvailableDatasets(tree, _ => false);
            _listCacheUtc = DateTime.UtcNow;
            return _listCache;
        }
        finally
        {
            ListLock.Release();
        }
    }

    /// <summary>Drops the cached remote listing so the next list reflects fresh state (called after a download
    /// finishes, so the just-installed dataset is recomputed — though installed-ness is recomputed every call
    /// regardless, this also lets a re-list pick up newly-published datasets without waiting out the TTL).</summary>
    public static void InvalidateListCache() => _listCache = null;

    /// <summary>Groups a recursive HF tree into one <see cref="RemoteDataset"/> per top-level <c>*.lance</c>
    /// folder, summing the sizes and counting the files under each. Top-level files (the repo's
    /// <c>README.md</c> / <c>.gitattributes</c>) and any non-<c>.lance</c> top-level entries are ignored.
    /// <paramref name="isInstalled"/> is given each folder's in-repo path. Results are sorted by name.</summary>
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
                continue; // a top-level file (README.md, .gitattributes) — not part of any dataset
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

    /// <summary>Extracts the files of one dataset folder from a (sub)tree: every <c>file</c> entry whose path is
    /// under <paramref name="repoPath"/><c>/</c>, with the prefix stripped to give the on-disk relative path.
    /// Directory entries are skipped (their dirs are created implicitly when files are written).</summary>
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
    #endregion

    #region HF HTTP
    /// <summary>GETs an HF tree URL (following <c>Link: rel="next"</c> pagination, so repos larger than one page
    /// are fully enumerated) and concatenates the JSON arrays. Sends the token as a bearer when present. Throws
    /// a readable error on a non-success status.</summary>
    private static async Task<JArray> FetchTreeAsync(string url, string token)
    {
        JArray all = [];
        string next = url;
        int guard = 0;
        while (next is not null && guard++ < 1000)
        {
            using HttpRequestMessage request = new(HttpMethod.Get, next);
            request.Headers.UserAgent.ParseAdd("SwarmUI-Quarry");
            string clean = CleanToken(token);
            if (!string.IsNullOrEmpty(clean))
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", clean);
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

    /// <summary>Reads the <c>rel="next"</c> URL from a <c>Link</c> response header, or null when there is no
    /// next page. HF returns absolute URLs there.</summary>
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

    /// <summary>The download URL for one in-repo file path, with each path segment URL-encoded.</summary>
    private static string ResolveUrl(string repoPath) =>
        $"{ResolveBase}/{string.Join('/', repoPath.Split('/').Select(Uri.EscapeDataString))}?download=true";
    #endregion

    #region Install state
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
    #endregion

    #region Download orchestration
    /// <summary>Mutable progress for the single in-flight (or most recently finished) dataset download. The UI
    /// polls a snapshot of this; <see cref="State"/> is one of <c>idle</c>, <c>starting</c>, <c>downloading</c>,
    /// <c>finalizing</c>, <c>done</c>, <c>error</c>, or <c>cancelled</c>. <see cref="Id"/> distinguishes runs so
    /// a poll can tell whether the status it reads is the one it started.</summary>
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

    /// <summary>A snapshot of the current download status (safe to read off any thread).</summary>
    public static DownloadStatus GetStatus()
    {
        lock (StateLock)
        {
            return _status.Clone();
        }
    }

    /// <summary>Requests cancellation of the in-flight download, if any. The temp files are cleaned up and the
    /// status moves to <c>cancelled</c>.</summary>
    public static void Cancel()
    {
        lock (StateLock)
        {
            _cancel?.Cancel();
        }
    }

    /// <summary>Validates the requested dataset against the live HF listing, then kicks off its download on a
    /// background task and returns immediately with the run id (the UI then polls <see cref="GetStatus"/>).
    /// Refuses to start a second download while one is active, and refuses when no datasets folder is set.
    /// <paramref name="redownload"/> deletes and re-fetches a dataset that is already installed.</summary>
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
        // Hidden temp/trash dirs (dot-prefixed) so an in-progress or being-replaced dataset is invisible to the
        // scanner (DatasetScanner skips dot-prefixed entries) — no partial dataset can ever be picked up.
        string tempDir = Path.Combine(folder, $".{target.RepoPath}.swarmdl-tmp");
        string trashDir = Path.Combine(folder, $".{target.RepoPath}.swarmdl-old");
        try
        {
            if (!redownload && Directory.Exists(finalDir))
            {
                // Already installed and not asked to replace it — nothing to do.
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
            string clean = CleanToken(token);
            if (!string.IsNullOrEmpty(clean))
            {
                headers["Authorization"] = $"Bearer {clean}";
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
            // Swap the freshly-downloaded folder into place via fast renames, so the dataset is only briefly
            // unavailable (the slow recursive delete of any old copy happens after the new one is already live).
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
            // Register + warm the new dataset so it shows up (with its row count) without a manual Refresh.
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

    /// <summary>Fetches the file list of one dataset folder from the HF subtree API.</summary>
    private static async Task<List<RemoteFile>> ListDatasetFilesAsync(string repoPath, string token)
    {
        string url = $"{TreeApiBase}/{string.Join('/', repoPath.Split('/').Select(Uri.EscapeDataString))}?recursive=true";
        JArray tree = await FetchTreeAsync(url, token);
        return ParseDatasetFiles(tree, repoPath);
    }

    /// <summary>Applies <paramref name="mutate"/> to the live status only if it is still the run identified by
    /// <paramref name="id"/> — so a late progress callback from a superseded run can't clobber a newer one.</summary>
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
    #endregion
}
