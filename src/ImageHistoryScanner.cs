using System.IO;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Utils;

namespace Quarry;

public static class ImageHistoryScanner
{
    public sealed class ScanStatus
    {
        public int Id { get; set; }
        public string State { get; set; } = "idle";
        public int FilesTotal { get; set; }
        public int FilesDone { get; set; }
        public int FilesIndexed { get; set; }
        public int FilesPruned { get; set; }
        public string Error { get; set; }

        public bool Active => State is "starting" or "scanning" or "finalizing";

        public ScanStatus Clone() => (ScanStatus)MemberwiseClone();
    }

    private sealed class ScanState
    {
        public readonly object Lock = new();
        public ScanStatus Status = new();
        public CancellationTokenSource Cancel;
        public Task Task;
        public int IdCounter;
    }

    private static readonly ConcurrentDictionary<string, ScanState> States = new(StringComparer.Ordinal);

    private static ScanState StateFor(string userId) => States.GetOrAdd(userId ?? "", _ => new ScanState());

    public static ScanStatus GetStatus(string userId)
    {
        ScanState state = StateFor(userId);
        lock (state.Lock)
        {
            return state.Status.Clone();
        }
    }

    public static void Cancel(string userId)
    {
        ScanState state = StateFor(userId);
        lock (state.Lock)
        {
            state.Cancel?.Cancel();
        }
    }

    public static void CancelAndWait(TimeSpan timeout)
    {
        List<Task> tasks = [];
        foreach (ScanState state in States.Values)
        {
            lock (state.Lock)
            {
                state.Cancel?.Cancel();
                if (state.Task is not null)
                {
                    tasks.Add(state.Task);
                }
            }
        }
        if (tasks.Count == 0)
        {
            return;
        }
        try
        {
            Task.WaitAll([.. tasks], timeout);
        }
        catch (Exception ex)
        {
            Logs.Debug($"Quarry: waiting for image-history scans to stop: {ex.Message}");
        }
    }

    public static (bool Ok, string Error, int Id) Start(Session session)
    {
        if (!DatasetManager.IsActive)
        {
            return (false, "Quarry has no datasets folder configured. Set one in the Quarry tab first.", 0);
        }
        if (!DatasetManager.RequirementsInstalled)
        {
            return (false, "The Lance reader is not installed yet. Install it from the Quarry tab first.", 0);
        }
        string root = Utilities.CombinePathWithAbsolute(Environment.CurrentDirectory, session.User.OutputDirectory);
        if (!Directory.Exists(root))
        {
            return (false, "Your image output directory does not exist yet.", 0);
        }
        string userId = session.User.UserID;
        bool starNoFolders = session.User.Settings.StarNoFolders;
        ScanState state = StateFor(userId);
        CancellationTokenSource cts;
        int id;
        lock (state.Lock)
        {
            if (state.Status.Active)
            {
                return (false, "An image-history scan is already in progress.", 0);
            }
            id = ++state.IdCounter;
            state.Cancel = CancellationTokenSource.CreateLinkedTokenSource(Program.GlobalProgramCancel);
            cts = state.Cancel;
            state.Status = new ScanStatus { Id = id, State = "starting" };
            state.Task = Task.Run(() => RunScan(userId, root, starNoFolders, id, cts, cts.Token));
        }
        return (true, null, id);
    }

    private static Dictionary<string, string> LoadExistingHashes(string userId, string lancePath)
    {
        if (!ImageHistoryIndex.Exists(userId))
        {
            return new Dictionary<string, string>(StringComparer.Ordinal);
        }
        try
        {
            return DatasetManager.Backend.GetPathHashes(lancePath);
        }
        catch (Exception ex)
        {
            Logs.Warning($"Quarry: image-history index at '{lancePath}' is unreadable ({ex.Message}); rebuilding it from scratch.");
            try
            {
                Directory.Delete(ImageHistoryIndex.IndexDirFor(userId), recursive: true);
            }
            catch (Exception delEx)
            {
                Logs.Warning($"Quarry: could not remove the corrupt image-history index: {delEx.Message}");
            }
            return new Dictionary<string, string>(StringComparer.Ordinal);
        }
    }

    private static void RunScan(string userId, string root, bool starNoFolders, int id, CancellationTokenSource cts, CancellationToken cancel)
    {
        ScanState state = StateFor(userId);
        string segment = ImageHistoryIndex.SafeUserSegment(userId);
        string indexDir = ImageHistoryIndex.IndexDirFor(userId);
        string lancePath = ImageHistoryIndex.LancePathFor(userId);
        string stagingPath = Path.Combine(DatasetManager.CacheFolder, $"imghist-staging-{segment}.json");
        string livePathsPath = Path.Combine(DatasetManager.CacheFolder, $"imghist-paths-{segment}.json");
        try
        {
            SetState(state, id, s => s.State = "scanning");
            List<ImageHistoryFile> files = ImageHistoryEnumerator.Enumerate(root, starNoFolders, cancel);
            SetState(state, id, s => s.FilesTotal = files.Count);
            Dictionary<string, string> existing = LoadExistingHashes(userId, lancePath);
            List<ImageHistoryFile> changed =
                [.. files.Where(f => !existing.TryGetValue(f.RelativePath, out string hash) || hash != f.Hash)];
            int skipped = files.Count - changed.Count;
            HashSet<string> currentPaths = [.. files.Select(f => f.RelativePath)];
            int prunedCount = existing.Keys.Count(p => !currentPaths.Contains(p));
            SetState(state, id, s => s.FilesDone = skipped);

            long indexedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            ConcurrentBag<ImageIndexRow> rows = [];
            int done = 0;
            Parallel.ForEach(
                changed,
                new ParallelOptions { MaxDegreeOfParallelism = Math.Clamp(Environment.ProcessorCount / 2, 2, 8), CancellationToken = cancel },
                file =>
                {
                    rows.Add(ImageMetadataExtractor.Extract(file, root, starNoFolders, indexedAt));
                    int progress = Interlocked.Increment(ref done);
                    if ((progress & 63) == 0)
                    {
                        SetState(state, id, s => s.FilesDone = skipped + progress);
                    }
                });
            cancel.ThrowIfCancellationRequested();

            SetState(state, id, s => { s.FilesDone = files.Count; s.FilesIndexed = rows.Count; s.State = "finalizing"; });
            Directory.CreateDirectory(indexDir);
            string staging = null;
            if (!rows.IsEmpty)
            {
                JArray rowArray = [.. rows.Select(r => r.ToJson())];
                File.WriteAllText(stagingPath, rowArray.ToString(Formatting.None));
                staging = stagingPath;
            }
            string livePaths = null;
            if (files.Count > 0 || existing.Count == 0)
            {
                JArray pathArray = [.. files.Select(f => new JObject { ["path"] = f.RelativePath })];
                File.WriteAllText(livePathsPath, pathArray.ToString(Formatting.None));
                livePaths = livePathsPath;
            }
            else
            {
                Logs.Warning($"Quarry: image-history scan found 0 files but the index holds {existing.Count}; skipping prune to avoid wiping the index. Check your output directory.");
                prunedCount = 0;
            }

            if (staging is not null || livePaths is not null)
            {
                DatasetManager.Backend.WriteImageHistory(indexDir, lancePath, staging, livePaths);
            }
            ImageHistorySearch.InvalidateFields(userId);
            SetState(state, id, s => { s.State = "done"; s.FilesPruned = prunedCount; });
            Logs.Info($"Quarry: image-history scan for '{userId}' indexed {rows.Count} new/changed and pruned {prunedCount} of {files.Count} file(s).");
        }
        catch (OperationCanceledException)
        {
            SetState(state, id, s => s.State = "cancelled");
            Logs.Info("Quarry: image-history scan cancelled.");
        }
        catch (Exception ex)
        {
            SetState(state, id, s => { s.State = "error"; s.Error = ex.Message; });
            Logs.Error($"Quarry: image-history scan failed: {ex.ReadableString()}");
        }
        finally
        {
            SafeDelete(stagingPath);
            SafeDelete(livePathsPath);
            lock (state.Lock)
            {
                if (ReferenceEquals(state.Cancel, cts))
                {
                    state.Cancel = null;
                }
            }
            cts.Dispose();
        }
    }

    private static void SetState(ScanState state, int id, Action<ScanStatus> mutate)
    {
        lock (state.Lock)
        {
            if (state.Status.Id != id)
            {
                return;
            }
            mutate(state.Status);
        }
    }

    private static void SafeDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception ex)
        {
            Logs.Debug($"Quarry: could not remove temp file '{path}': {ex.Message}");
        }
    }
}
