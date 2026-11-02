using System.Text.Json.Serialization;

namespace DoggyAgent;

/// <summary>One capture event, matching POST /api/capture event shape.</summary>
public sealed class CaptureEvent
{
    [JsonPropertyName("app")] public string App { get; set; } = "";
    [JsonPropertyName("bundleId")] public string? BundleId { get; set; }
    [JsonPropertyName("window")] public string Window { get; set; } = "";
    [JsonPropertyName("url")] public string? Url { get; set; }
    [JsonPropertyName("text")] public string Text { get; set; } = "";
    [JsonPropertyName("capturedAt")] public string CapturedAt { get; set; } = "";
}

public sealed class CaptureBatch
{
    [JsonPropertyName("events")] public List<CaptureEvent> Events { get; set; } = new();
}

// ---- Auth ----

public sealed class LoginRequest
{
    [JsonPropertyName("email")] public string Email { get; set; } = "";
    [JsonPropertyName("password")] public string Password { get; set; } = "";
    [JsonPropertyName("deviceName")] public string DeviceName { get; set; } = "";
    [JsonPropertyName("deviceKind")] public string DeviceKind { get; set; } = "windows-agent";
}

public sealed class LoginResponse
{
    [JsonPropertyName("token")] public string? Token { get; set; }
    [JsonPropertyName("user")] public UserDto? User { get; set; }
    [JsonPropertyName("device")] public DeviceDto? Device { get; set; }
}

public sealed class UserDto
{
    [JsonPropertyName("id")] public string? Id { get; set; }
    [JsonPropertyName("email")] public string? Email { get; set; }
}

public sealed class DeviceDto
{
    [JsonPropertyName("id")] public string? Id { get; set; }
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("kind")] public string? Kind { get; set; }
}
