using System.Runtime.InteropServices;
using DoggyAgent;

static class Program
{
    private const int ATTACH_PARENT_PROCESS = -1;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(int dwProcessId);

    /// <summary>
    /// No arguments → tray app. Any arguments → the original CLI. The exe is a
    /// WinExe (no console window), so in CLI mode we attach to the parent
    /// terminal's console to keep stdout/stderr working.
    /// </summary>
    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length == 0)
            return TrayApp.Run();

        AttachConsole(ATTACH_PARENT_PROCESS);
        return Cli.Dispatch(args);
    }
}

static class Cli
{
    public static int Dispatch(string[] args)
    {
        if (args.Length == 0) { PrintUsage(); return 1; }

        try
        {
            return args[0] switch
            {
                "login" => Login(args[1..]),
                "run" => Run(args[1..]),
                "status" => Status(),
                "-h" or "--help" or "help" => UsageExit(),
                _ => Unknown(args[0]),
            };
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("error: " + ex.Message);
            return 1;
        }
    }

    static int UsageExit() { PrintUsage(); return 0; }
    static int Unknown(string cmd) { Console.Error.WriteLine($"unknown command: {cmd}"); PrintUsage(); return 1; }

    static void PrintUsage()
    {
        Console.WriteLine(
@"doggy-agent — Windows desktop capture agent for Doggy

Usage:
  doggy-agent                (no arguments: start the Doggy tray app)
  doggy-agent login --server URL --email E --password P [--device-name N]
  doggy-agent run [--dry-run] [--once]
  doggy-agent status

Reads on-screen text via Windows UI Automation and ships new text to the server.
Config is stored at %USERPROFILE%\.doggy\agent.json. Create %USERPROFILE%\.doggy\paused to pause.");
    }

    // ---- login ----
    static int Login(string[] args)
    {
        var opts = ParseOpts(args);
        string server = Require(opts, "server");
        string email = Require(opts, "email");
        string password = Require(opts, "password");
        string deviceName = opts.GetValueOrDefault("device-name") ?? Environment.MachineName;

        var client = new ApiClient(server);
        var resp = client.LoginAsync(email, password, deviceName).GetAwaiter().GetResult();
        if (string.IsNullOrEmpty(resp.Token))
        {
            Console.Error.WriteLine("login: server returned no token");
            return 1;
        }

        var cfg = AgentConfig.Load() ?? new AgentConfig();
        cfg.Server = server;
        cfg.Token = resp.Token!;
        cfg.DeviceName = deviceName;
        cfg.Save();

        Console.WriteLine($"logged in as {resp.User?.Email ?? email}; token saved to {AgentConfig.ConfigPath}");
        return 0;
    }

    // ---- status ----
    static int Status()
    {
        var cfg = AgentConfig.Load();
        if (cfg is null || string.IsNullOrEmpty(cfg.Token))
        {
            Console.WriteLine("not logged in (run `doggy-agent login`)");
            return 1;
        }
        Console.WriteLine($"server:     {cfg.Server}");
        Console.WriteLine($"device:     {cfg.DeviceName}");
        Console.WriteLine($"token:      {Mask(cfg.Token)}");
        Console.WriteLine($"config:     {AgentConfig.ConfigPath}");
        Console.WriteLine($"paused:     {(AgentConfig.IsPaused() ? "yes (" + AgentConfig.PausePath + ")" : "no")}");
        Console.WriteLine($"excludeApps: {(cfg.ExcludeApps.Count == 0 ? "(none)" : string.Join(", ", cfg.ExcludeApps))}");
        return 0;
    }

    static string Mask(string t) => t.Length <= 8 ? "****" : t[..4] + "…" + t[^4..];

    // ---- run ----
    static int Run(string[] args)
    {
        var opts = ParseOpts(args);
        bool dryRun = opts.ContainsKey("dry-run");
        bool once = opts.ContainsKey("once");

        var engine = new CaptureEngine(dryRun, once, Console.WriteLine);
        if (!engine.Start())
        {
            Console.Error.WriteLine("not logged in (run `doggy-agent login`)");
            return 1;
        }

        Console.CancelKeyPress += (_, e) => { e.Cancel = true; engine.RequestStop(); };
        engine.Join(); // capture runs on the engine's STA thread; flushes before exit
        return engine.ExitCode;
    }

    // ---- tiny opt parser ("--key value" or "--flag") ----
    static Dictionary<string, string> ParseOpts(string[] args)
    {
        var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < args.Length; i++)
        {
            var a = args[i];
            if (!a.StartsWith("--")) continue;
            var key = a[2..];
            if (i + 1 < args.Length && !args[i + 1].StartsWith("--"))
                d[key] = args[++i];
            else
                d[key] = "true";
        }
        return d;
    }

    static string Require(Dictionary<string, string> opts, string key)
    {
        if (opts.TryGetValue(key, out var v) && v != "true" && !string.IsNullOrWhiteSpace(v))
            return v;
        throw new ArgumentException($"missing required --{key}");
    }
}
