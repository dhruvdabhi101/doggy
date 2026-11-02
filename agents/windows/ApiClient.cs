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
        _server = server.Trim().TrimEnd('/');
        _token = token;
    }

    public Task<LoginResponse> LoginAsync(string email, string password, string deviceName) =>
        AuthAsync("login", email, password, deviceName);

    public Task<LoginResponse> SignupAsync(string email, string password, string deviceName) =>
        AuthAsync("signup", email, password, deviceName);

    private async Task<LoginResponse> AuthAsync(string kind, string email, string password, string deviceName)
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
        using var resp = await _http.PostAsync($"{_server}/api/auth/{kind}", content);
        var text = await resp.Content.ReadAsStringAsync();
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"{kind} failed ({(int)resp.StatusCode}): {text}");
        return JsonSerializer.Deserialize<LoginResponse>(text)
               ?? throw new InvalidOperationException($"{kind}: empty response");
    }

    /// <summary>POST a capture batch. Returns the HTTP status code (2xx = accepted).</summary>
    public async Task<int> PostCaptureAsync(IReadOnlyList<CaptureEvent> events)
    {
        if (events.Count == 0) return 200;
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
        return (int)resp.StatusCode;
    }

    /// <summary>POST /api/notes {text, source:"text"}; extraction is synchronous server-side.</summary>
    public async Task<NoteResponse> PostNoteAsync(string text)
    {
        var body = JsonSerializer.Serialize(new NoteRequest { Text = text, Source = "text" });
        using var content = new StringContent(body, Encoding.UTF8, "application/json");
        using var msg = new HttpRequestMessage(HttpMethod.Post, $"{_server}/api/notes") { Content = content };
        if (!string.IsNullOrEmpty(_token))
            msg.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
        using var resp = await _http.SendAsync(msg);
        var respText = await resp.Content.ReadAsStringAsync();
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"note failed ({(int)resp.StatusCode}): {respText}");
        return JsonSerializer.Deserialize<NoteResponse>(respText) ?? new NoteResponse();
    }
}
