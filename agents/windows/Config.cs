using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DoggyAgent;

/// <summary>Persisted agent config at %USERPROFILE%\.doggy\agent.json</summary>
public sealed class AgentConfig
{
    [JsonPropertyName("server")] public string Server { get; set; } = "";
    [JsonPropertyName("token")] public string Token { get; set; } = "";
    [JsonPropertyName("deviceName")] public string? DeviceName { get; set; }
    /// <summary>Extra process/app names to never capture (case-insensitive substring match).</summary>
    [JsonPropertyName("excludeApps")] public List<string> ExcludeApps { get; set; } = new();

    public static string DoggyDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".doggy");

    public static string ConfigPath => Path.Combine(DoggyDir, "agent.json");
    public static string PausePath => Path.Combine(DoggyDir, "paused");

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static AgentConfig? Load()
    {
        try
        {
            if (!File.Exists(ConfigPath)) return null;
            var json = File.ReadAllText(ConfigPath);
            return JsonSerializer.Deserialize<AgentConfig>(json);
        }
        catch
        {
            return null;
        }
    }

    public void Save()
    {
        Directory.CreateDirectory(DoggyDir);
        File.WriteAllText(ConfigPath, JsonSerializer.Serialize(this, JsonOpts));
    }

    public static bool IsPaused()
    {
        try { return File.Exists(PausePath); } catch { return false; }
    }
}
