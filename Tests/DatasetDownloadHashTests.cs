using System.IO;
using System.Net;
using System.Net.Http;
using Newtonsoft.Json.Linq;
using SwarmUI.Utils;
using Xunit;

namespace Quarry.Tests;

[Collection("OutputColumns")]
public class DatasetDownloadHashTests : IDisposable
{
    private const string FirstHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string SecondHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private readonly string _root = Path.Combine(Path.GetTempPath(), "quarry-download-hash-" + Guid.NewGuid().ToString("N"));
    private readonly string _previousFolder = DatasetManager.DatasetsFolder;
    private readonly HttpClient _previousClient = Utilities.UtilWebClient;

    public DatasetDownloadHashTests()
    {
        Directory.CreateDirectory(_root);
        DatasetManager.DatasetsFolder = _root;
        DatasetDownloader.InvalidateListCache();
    }

    private static string Descriptor(string hash) => new JObject
    {
        ["version"] = 1, ["columns"] = new JObject(), ["datasetHash"] = hash,
    }.ToString();

    [Fact]
    public void ExistingInstall_MissingDescriptorOrHash_ShowsUpdateOncePublished()
    {
        Assert.False(DatasetDownloadHash.HasUpdate(_root, null));
        Assert.True(DatasetDownloadHash.HasUpdate(_root, FirstHash));
        File.WriteAllText(Path.Combine(_root, CasingStorage.DescriptorName), "{\"version\":1,\"columns\":{}}");
        Assert.True(DatasetDownloadHash.HasUpdate(_root, FirstHash));
    }

    [Fact]
    public void MatchingHashClearsUpdate_AndSurvivesDatasetRename()
    {
        string directory = Path.Combine(_root, "old.lance");
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, CasingStorage.DescriptorName), Descriptor(FirstHash));
        Assert.False(DatasetDownloadHash.HasUpdate(directory, FirstHash));
        Assert.True(DatasetDownloadHash.HasUpdate(directory, SecondHash));
        string renamed = Path.Combine(_root, "new.lance");
        Directory.Move(directory, renamed);
        Assert.False(DatasetDownloadHash.HasUpdate(renamed, FirstHash));
        File.WriteAllText(Path.Combine(renamed, CasingStorage.DescriptorName), Descriptor(SecondHash));
        Assert.False(DatasetDownloadHash.HasUpdate(renamed, SecondHash));
        Assert.Empty(CasingStorage.Load(renamed));
    }

    [Theory]
    [InlineData("invalid json")]
    [InlineData("{}")]
    [InlineData("{\"datasetHash\":{}}")]
    [InlineData("{\"datasetHash\":\"invalid\"}")]
    public void InvalidLocalMetadata_IsTreatedAsMissingHash(string json)
    {
        File.WriteAllText(Path.Combine(_root, CasingStorage.DescriptorName), json);
        Assert.True(DatasetDownloadHash.HasUpdate(_root, FirstHash));
        Assert.False(DatasetDownloadHash.HasUpdate(_root, null));
    }

    [Fact]
    public async Task Listing_FetchesOnlyPublishedMetadata_AndRechecksLocalHashWhileCached()
    {
        string directory = Path.Combine(_root, "org.repo.lance");
        Directory.CreateDirectory(directory);
        string hash = FirstHash;
        List<string> urls = [];
        Utilities.UtilWebClient = new HttpClient(new Handler(request =>
        {
            string url = request.RequestUri.AbsoluteUri;
            urls.Add(url);
            string body = url.EndsWith("/revision/main") ? "{\"sha\":\"commit-a\"}"
                : url.Contains("/resolve/") ? Descriptor(hash)
                : """
                    [{"type":"file","path":"org.repo.lance/quarry-storage.json","size":120},
                     {"type":"file","path":"org.repo.lance/data/one.lance","size":10000000000}]
                    """;
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body) };
        }));
        RemoteDataset first = Assert.Single(await DatasetDownloader.ListAvailableAsync(null));
        Assert.True(first.Installed);
        Assert.True(first.UpdateAvailable);
        Assert.Equal("commit-a", first.Revision);
        Assert.Contains(urls, url => url.Contains("/tree/commit-a?"));
        Assert.Contains(urls, url => url.Contains("/resolve/commit-a/org.repo.lance/quarry-storage.json?"));
        Assert.DoesNotContain(urls, url => url.Contains("/data/"));
        File.WriteAllText(Path.Combine(directory, CasingStorage.DescriptorName), Descriptor(FirstHash));
        hash = SecondHash;
        Assert.False(Assert.Single(await DatasetDownloader.ListAvailableAsync(null)).UpdateAvailable);
        Assert.Equal(3, urls.Count);
        Assert.True(Assert.Single(await DatasetDownloader.ListAvailableAsync(null, forceRefresh: true)).UpdateAvailable);
        Assert.Equal(6, urls.Count);
        File.WriteAllText(Path.Combine(directory, CasingStorage.DescriptorName), Descriptor(SecondHash));
        Assert.False(Assert.Single(await DatasetDownloader.ListAvailableAsync(null)).UpdateAvailable);
        Assert.Equal(6, urls.Count);
        Directory.Delete(directory, true);
        RemoteDataset absent = Assert.Single(await DatasetDownloader.ListAvailableAsync(null));
        Assert.False(absent.Installed);
        Assert.False(absent.UpdateAvailable);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task UnpublishedOrUnavailableHash_DoesNotInventAnUpdate(bool requestFails)
    {
        Directory.CreateDirectory(Path.Combine(_root, "org.repo.lance"));
        Utilities.UtilWebClient = new HttpClient(new Handler(request =>
        {
            string url = request.RequestUri.AbsoluteUri;
            if (url.Contains("/resolve/") && requestFails)
            {
                return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
            }
            string body = url.EndsWith("/revision/main") ? "{\"sha\":\"commit-a\"}"
                : url.Contains("/resolve/") ? "{\"version\":1,\"columns\":{}}"
                : "[{\"type\":\"file\",\"path\":\"org.repo.lance/quarry-storage.json\",\"size\":32}]";
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body) };
        }));
        Assert.False(Assert.Single(await DatasetDownloader.ListAvailableAsync(null)).UpdateAvailable);
    }

    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(respond(request));
    }

    public void Dispose()
    {
        if (Utilities.UtilWebClient != _previousClient)
        {
            Utilities.UtilWebClient.Dispose();
            Utilities.UtilWebClient = _previousClient;
        }
        DatasetDownloader.InvalidateListCache();
        DatasetManager.DatasetsFolder = _previousFolder;
        Directory.Delete(_root, true);
    }
}
