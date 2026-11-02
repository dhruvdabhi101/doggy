using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

namespace DoggyAgent;

/// <summary>
/// Tray (NotifyIcon) front-end. UI runs on the WinForms thread; capture runs on
/// the <see cref="CaptureEngine"/>'s own STA thread.
/// </summary>
public sealed class TrayApp : ApplicationContext
{
    public const string DefaultServer = "https://doggy.ruv.world";
    private const string MutexName = @"Local\Doggy.Tray.SingleInstance";
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValueName = "Doggy";

    private static string WelcomedMarker => Path.Combine(AgentConfig.DoggyDir, "tray-welcomed");

    public static int Run()
    {
        using var mutex = new Mutex(true, MutexName, out bool createdNew);
        if (!createdNew)
        {
            MessageBox.Show("Doggy is already running — look for it in the system tray.", "Doggy",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) =>
            MessageBox.Show(e.Exception.Message, "Doggy error", MessageBoxButtons.OK, MessageBoxIcon.Error);

        using var ctx = new TrayApp();
        Application.Run(ctx);
        GC.KeepAlive(mutex);
        return 0;
    }

    // ---------------------------------------------------------------------

    private readonly NotifyIcon _tray;
    private readonly ContextMenuStrip _menu;
    private readonly ToolStripMenuItem _statusItem;
    private readonly ToolStripMenuItem _detailItem;
    private readonly ToolStripMenuItem _noteItem;
    private readonly ToolStripMenuItem _pauseItem;
    private readonly ToolStripMenuItem _openItem;
    private readonly ToolStripMenuItem _startupItem;
    private readonly ToolStripMenuItem _accountItem;
    private readonly System.Windows.Forms.Timer _refresh;
    private readonly SynchronizationContext _ui;
    private CaptureEngine _engine;
    private SignInForm? _signIn;
    private QuickNoteForm? _note;

    private TrayApp()
    {
        _ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        _engine = NewEngine();

        _statusItem = new ToolStripMenuItem("Doggy") { Enabled = false };
        _detailItem = new ToolStripMenuItem("") { Enabled = false };
        _noteItem = new ToolStripMenuItem("Quick note…", null, (_, _) => ShowQuickNote());
        _pauseItem = new ToolStripMenuItem("Pause capture", null, (_, _) => TogglePause());
        _openItem = new ToolStripMenuItem("Open Doggy", null, (_, _) => OpenDoggy());
        _startupItem = new ToolStripMenuItem("Start with Windows", null, (_, _) => ToggleStartup());
        _accountItem = new ToolStripMenuItem("Sign out", null, (_, _) => SignOutOrIn());
        var exitItem = new ToolStripMenuItem("Exit", null, (_, _) => ExitApp());

        _menu = new ContextMenuStrip();
        _menu.Items.AddRange(new ToolStripItem[]
        {
            _statusItem, _detailItem, new ToolStripSeparator(),
            _noteItem, _pauseItem, _openItem, new ToolStripSeparator(),
            _startupItem, _accountItem, exitItem,
        });
        _menu.Opening += (_, _) => RefreshUi();

        _tray = new NotifyIcon
        {
            Icon = LoadIcon(),
            Text = "Doggy",
            ContextMenuStrip = _menu,
            Visible = true,
        };
        _tray.DoubleClick += (_, _) => { if (IsSignedIn) ShowQuickNote(); else ShowSignIn(); };

        _refresh = new System.Windows.Forms.Timer { Interval = 2000 };
        _refresh.Tick += (_, _) => RefreshUi();
        _refresh.Start();

        if (!File.Exists(WelcomedMarker))
        {
            _tray.ShowBalloonTip(5000, "Doggy", "Doggy is running in the tray", ToolTipIcon.Info);
            try { Directory.CreateDirectory(AgentConfig.DoggyDir); File.WriteAllText(WelcomedMarker, DateTime.UtcNow.ToString("o")); }
            catch { }
        }

        if (!_engine.Start())
            ShowSignIn();
        RefreshUi();
    }

    private CaptureEngine NewEngine()
    {
        var e = new CaptureEngine { StopOnUnauthorized = true };
        // Engine events fire on the capture thread → marshal to the UI thread.
        e.StatusChanged += () => _ui.Post(_ => RefreshUi(), null);
        return e;
    }

    private static bool IsSignedIn => !string.IsNullOrEmpty(AgentConfig.Load()?.Token);

    // ---- status ----

    private void RefreshUi()
    {
        bool signedIn = IsSignedIn;
        var status = _engine.Status;
        if (!signedIn) status = CaptureStatus.NotSignedIn;

        string head = status switch
        {
            CaptureStatus.Capturing => "● Capturing",
            CaptureStatus.Paused => "❚❚ Paused",
            CaptureStatus.NotSignedIn => "Not signed in",
            CaptureStatus.Error => "⚠ Upload error",
            _ => "Stopped",
        };
        _statusItem.Text = "Doggy — " + head;

        var last = _engine.LastUploadUtc;
        string detail = $"{_engine.EventsSent} events sent · last upload " +
                        (last is null ? "never" : last.Value.ToLocalTime().ToString("HH:mm:ss"));
        if (status == CaptureStatus.Error && !string.IsNullOrEmpty(_engine.LastError))
            detail = Trunc(_engine.LastError!, 60);
        if (status == CaptureStatus.NotSignedIn)
            detail = string.IsNullOrEmpty(_engine.LastError) ? "Sign in to start capturing" : Trunc(_engine.LastError!, 60);
        _detailItem.Text = detail;

        bool paused = CaptureEngine.IsPaused;
        _pauseItem.Text = paused ? "Resume capture" : "Pause capture";
        _pauseItem.Enabled = signedIn;
        _noteItem.Enabled = signedIn;
        _accountItem.Text = signedIn ? "Sign out" : "Sign in…";
        _startupItem.Checked = IsStartupEnabled();

        // NotifyIcon.Text is limited to 127 chars.
        _tray.Text = Trunc("Doggy — " + head, 120);
    }

    private static string Trunc(string s, int n) => s.Length <= n ? s : s[..(n - 1)] + "…";

    // ---- actions ----

    private void TogglePause()
    {
        try
        {
            if (CaptureEngine.IsPaused) _engine.Resume(); else _engine.Pause();
        }
        catch (Exception ex) { Error("Could not change pause state: " + ex.Message); }
        RefreshUi();
    }

    private void OpenDoggy()
    {
        string url = AgentConfig.Load()?.Server is { Length: > 0 } s ? s : DefaultServer;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception ex) { Error("Could not open browser: " + ex.Message); }
    }

    private void ShowQuickNote()
    {
        var cfg = AgentConfig.Load();
        if (cfg is null || string.IsNullOrEmpty(cfg.Token)) { ShowSignIn(); return; }
        if (_note is { IsDisposed: false }) { _note.Activate(); return; }
        _note = new QuickNoteForm(new ApiClient(cfg.Server, cfg.Token));
        _note.Show();
        _note.Activate();
    }

    private void ShowSignIn()
    {
        if (_signIn is { IsDisposed: false }) { _signIn.Activate(); return; }
        _signIn = new SignInForm(AgentConfig.Load()?.Server);
        _signIn.SignedIn += () =>
        {
            _engine.Stop(2000);
            _engine = NewEngine();
            _engine.Start();
            RefreshUi();
            _tray.ShowBalloonTip(3000, "Doggy", "Signed in — capture is running.", ToolTipIcon.Info);
        };
        _signIn.Show();
        _signIn.Activate();
    }

    private void SignOutOrIn()
    {
        if (!IsSignedIn) { ShowSignIn(); return; }
        if (MessageBox.Show("Sign out of Doggy on this PC? Capture will stop.", "Doggy",
                MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;

        _engine.Stop(5000); // flushes queued events with the old token first
        var cfg = AgentConfig.Load();
        if (cfg is not null) { cfg.Token = ""; cfg.Save(); }
        _engine = NewEngine();
        RefreshUi();
        ShowSignIn();
    }

    private void ExitApp()
    {
        _refresh.Stop();
        _tray.Visible = false;
        _engine.Stop(5000);
        ExitThread();
    }

    private static void Error(string msg) =>
        MessageBox.Show(msg, "Doggy", MessageBoxButtons.OK, MessageBoxIcon.Warning);

    // ---- Start with Windows (HKCU Run key) ----

    private static string ExePath => Environment.ProcessPath ?? Application.ExecutablePath;

    private static bool IsStartupEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, false);
            return key?.GetValue(RunValueName) is string;
        }
        catch { return false; }
    }

    private void ToggleStartup()
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, true);
            if (key.GetValue(RunValueName) is string)
                key.DeleteValue(RunValueName, false);
            else
                key.SetValue(RunValueName, $"\"{ExePath}\"", RegistryValueKind.String);
        }
        catch (Exception ex) { Error("Could not update startup setting: " + ex.Message); }
        RefreshUi();
    }

    // ---- icon ----

    internal static Icon LoadIcon()
    {
        try
        {
            using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("Doggy.doggy.ico");
            if (s is not null) return new Icon(s, SystemInformation.SmallIconSize);
        }
        catch { }
        try
        {
            var assoc = Icon.ExtractAssociatedIcon(ExePath);
            if (assoc is not null) return assoc;
        }
        catch { }
        return DrawFallbackIcon();
    }

    private static Icon DrawFallbackIcon()
    {
        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using var bg = new SolidBrush(Color.FromArgb(0xc2, 0x55, 0x2d));
            g.FillEllipse(bg, 0, 0, 31, 31);
            using var white = new SolidBrush(Color.White);
            g.FillEllipse(white, 8, 12, 16, 14);
            g.FillEllipse(white, 6, 4, 6, 10);
            g.FillEllipse(white, 20, 4, 6, 10);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _refresh.Dispose();
            _tray.Dispose();
            _menu.Dispose();
            _signIn?.Dispose();
            _note?.Dispose();
        }
        base.Dispose(disposing);
    }
}
