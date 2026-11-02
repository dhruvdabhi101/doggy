using System.IO;
using System.Text.Json;

namespace DoggyAgent;

public enum CaptureStatus { Stopped, Capturing, Paused, NotSignedIn, Error }

/// <summary>
/// The capture loop (foreground window → UIA text → line diff → batched upload),
/// shared by the CLI (`run`) and the tray app. The loop runs on its own STA
/// thread because UI Automation requires one. Status properties are safe to read
/// from any thread; <see cref="StatusChanged"/> fires on the capture thread.
/// </summary>
public sealed class CaptureEngine
{
    private const int IntervalMs = 3000;

    private readonly bool _dryRun;
    private readonly bool _once;
    private readonly Action<string>? _log;
    private readonly object _gate = new();

    private Thread? _thread;
    private CancellationTokenSource? _cts;
    private volatile CaptureStatus _status = CaptureStatus.Stopped;
    private long _eventsSent;
    private long _lastUploadTicks; // UTC ticks, 0 = never
    private volatile string? _lastError;
    private volatile bool _uploadFailing;

    public CaptureEngine(bool dryRun = false, bool once = false, Action<string>? log = null)
    {
        _dryRun = dryRun;
        _once = once;
        _log = log;
    }

    public CaptureStatus Status => _status;
    public long EventsSent => Interlocked.Read(ref _eventsSent);
    public DateTime? LastUploadUtc
    {
        get { long t = Interlocked.Read(ref _lastUploadTicks); return t == 0 ? null : new DateTime(t, DateTimeKind.Utc); }
    }
    public string? LastError => _lastError;
    public bool IsRunning => _thread?.IsAlive == true;
    /// <summary>1 if the loop ended because the token was rejected / missing, else 0.</summary>
    public int ExitCode { get; private set; }

    /// <summary>Raised whenever <see cref="Status"/> changes (on the capture thread or caller of Start/Stop).</summary>
    public event Action? StatusChanged;

    /// <summary>Tray mode: stop and report NotSignedIn on HTTP 401/403. CLI keeps retrying (legacy behaviour).</summary>
    public bool StopOnUnauthorized { get; init; }

    public static bool IsPaused => AgentConfig.IsPaused();

    /// <summary>Starts the capture thread. Returns false if not signed in (status = NotSignedIn).</summary>
    public bool Start()
    {
        lock (_gate)
        {
            if (IsRunning) return true;

            var cfg = AgentConfig.Load();
            if (!_dryRun && (cfg is null || string.IsNullOrEmpty(cfg.Token)))
            {
                _lastError = "not logged in";
                ExitCode = 1;
                SetStatus(CaptureStatus.NotSignedIn);
                return false;
            }
            cfg ??= new AgentConfig();

            ExitCode = 0;
            _lastError = null;
            _uploadFailing = false;
            _cts = new CancellationTokenSource();
            var ct = _cts.Token;
            _thread = new Thread(() => Loop(cfg, ct))
            {
                IsBackground = true,
                Name = "Doggy capture (STA)",
            };
            _thread.SetApartmentState(ApartmentState.STA); // UI Automation requires STA
            SetStatus(IsPaused && !_dryRun ? CaptureStatus.Paused : CaptureStatus.Capturing);
            _thread.Start();
            return true;
        }
    }

    /// <summary>Signals the loop to stop (it flushes queued events before exiting). Non-blocking.</summary>
    public void RequestStop()
    {
        try { _cts?.Cancel(); } catch (ObjectDisposedException) { }
    }

    /// <summary>Stops the loop and waits (bounded) for the final flush.</summary>
    public void Stop(int timeoutMs = 10_000)
    {
        Thread? t;
        lock (_gate) { t = _thread; RequestStop(); }
        t?.Join(timeoutMs);
        if (_status != CaptureStatus.NotSignedIn) SetStatus(CaptureStatus.Stopped);
    }

    /// <summary>Blocks until the capture thread exits.</summary>
    public void Join() => _thread?.Join();

    /// <summary>Creates the pause file (%USERPROFILE%\.doggy\paused). Honoured by CLI and tray alike.</summary>
    public void Pause()
    {
        Directory.CreateDirectory(AgentConfig.DoggyDir);
        File.WriteAllText(AgentConfig.PausePath, "");
        if (IsRunning) SetStatus(CaptureStatus.Paused);
    }

    public void Resume()
    {
        try { File.Delete(AgentConfig.PausePath); } catch { }
        if (IsRunning) SetStatus(_uploadFailing ? CaptureStatus.Error : CaptureStatus.Capturing);
    }

    private void SetStatus(CaptureStatus s)
    {
        if (_status == s) return;
        _status = s;
        try { StatusChanged?.Invoke(); } catch { }
    }

    private void Loop(AgentConfig cfg, CancellationToken ct)
    {
        var differ = new LineDiffer();
        BatchSender? sender = null;
        bool unauthorized = false;

        if (!_dryRun)
        {
            sender = new BatchSender(cfg);
            sender.Sent += n =>
            {
                Interlocked.Add(ref _eventsSent, n);
                Interlocked.Exchange(ref _lastUploadTicks, DateTime.UtcNow.Ticks);
                _uploadFailing = false;
                _lastError = null;
                if (_status == CaptureStatus.Error) SetStatus(CaptureStatus.Capturing);
            };
            sender.Failed += (status, msg) =>
            {
                _lastError = msg;
                _uploadFailing = true;
                if (StopOnUnauthorized && (status == 401 || status == 403))
                {
                    unauthorized = true;
                    _lastError = "token rejected by server — sign in again";
                }
                SetStatus(CaptureStatus.Error);
            };
        }

        while (!ct.IsCancellationRequested && !unauthorized)
        {
            if (!_dryRun && AgentConfig.IsPaused())
            {
                SetStatus(CaptureStatus.Paused);
                if (_once) break;
                Sleep(IntervalMs, ct);
                continue;
            }
            if (_status == CaptureStatus.Paused)
                SetStatus(_uploadFailing ? CaptureStatus.Error : CaptureStatus.Capturing);

            CaptureResult res;
            try { res = UiaCapturer.CaptureForeground(cfg.ExcludeApps); }
            catch (Exception ex)
            {
                res = new CaptureResult { Skipped = true, SkipReason = "loop error: " + ex.Message };
            }

            if (!res.Skipped)
            {
                string windowKey = res.App + "\u0000" + res.Window;
                string newText = differ.Diff(windowKey, res.Text);
                if (!string.IsNullOrEmpty(newText))
                {
                    var ev = new CaptureEvent
                    {
                        App = string.IsNullOrEmpty(res.App) ? "Unknown" : res.App,
                        BundleId = res.BundleId,
                        Window = res.Window,
                        Url = res.Url,
                        Text = newText,
                        CapturedAt = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                    };

                    if (_dryRun)
                        _log?.Invoke(JsonSerializer.Serialize(new[] { ev },
                            new JsonSerializerOptions { WriteIndented = true }));
                    else
                        sender!.Enqueue(ev);
                }
                else if (_dryRun)
                {
                    _log?.Invoke("[]  // no new text for " + res.App + " / " + res.Window);
                }
            }
            else if (_dryRun)
            {
                _log?.Invoke($"[]  // skipped: {res.SkipReason} (app={res.App})");
            }

            if (_once) break;
            sender?.MaybeFlush();
            Sleep(IntervalMs, ct);
        }

        if (!unauthorized) sender?.FlushNow();

        if (unauthorized)
        {
            ExitCode = 1;
            _log?.Invoke("error: " + _lastError);
            SetStatus(CaptureStatus.NotSignedIn);
        }
        else if (_status != CaptureStatus.NotSignedIn)
        {
            SetStatus(CaptureStatus.Stopped);
        }
    }

    private static void Sleep(int ms, CancellationToken ct)
    {
        try { Task.Delay(ms, ct).Wait(ct); } catch { }
    }
}
