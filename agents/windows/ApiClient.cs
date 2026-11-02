using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace DoggyAgent;

public sealed class ApiClient
{
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private readonly string _server;
    private readonly string? _token;

    public ApiClient(string server, string? token = null)
    {
        _server = server.TrimEnd('/');
        _token = token;
    }

    public async Task<LoginResponse> LoginAsync(string email, string password, string deviceName)
    {
        var req = new LoginRequest
        {
            Email = email,
            Password = password,
            DeviceName = deviceName,
            DeviceKind = "windows-agent",
        };
        var body = JsonSerializer.Serialize(req);
        using var content = new StringContent(body, Encoding.UTF8, "application/json");
        using var resp = await _http.PostAsync($"{_server}/api/auth/login", content);
        var text = await resp.Content.ReadAsStringAsync();
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"login failed ({(int)resp.StatusCode}): {text}");
        return JsonSerializer.Deserialize<LoginResponse>(text)
               ?? throw new InvalidOperationException("login: empty response");
    }

    /// <summary>POST a capture batch. Returns true on 2xx (so caller can keep/drop the queue).</summary>
    public async Task<bool> PostCaptureAsync(IReadOnlyList<CaptureEvent> events)
    {
        if (events.Count == 0) return true;
        var batch = new CaptureBatch { Events = new List<CaptureEvent>(events) };
        var body = JsonSerializer.Serialize(batch);
        using var content = new StringContent(body, Encoding.UTF8, "application/json");
        using var msg = new HttpRequestMessage(HttpMethod.Post, $"{_server}/api/capture")
        {
            Content = content,
        };
        if (!string.IsNullOrEmpty(_token))
            msg.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);

        using var resp = await _http.SendAsync(msg);
        return resp.IsSuccessStatusCode;
    }
}
