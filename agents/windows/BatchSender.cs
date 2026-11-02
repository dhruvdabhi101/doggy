using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace DoggyAgent;

/// <summary>
/// Queues capture events and POSTs them to /api/capture every ~20s (or when the
/// queue exceeds 100 events). On failure the queue is kept (capped at ~5 MB,
/// oldest dropped) and retried with exponential backoff.
/// </summary>
public sealed class BatchSender
{
    private const int FlushIntervalMs = 20_000;
    private const int FlushCountThreshold = 100;
    private const int MaxPerRequest = 200;         // server limit
    private const long MaxQueueBytes = 5L * 1024 * 1024;

    private readonly ApiClient _client;
    private readonly List<CaptureEvent> _queue = new();
    private long _queueBytes;
    private readonly Stopwatch _sinceFlush = Stopwatch.StartNew();

    // backoff state
    private int _backoffMs;
    private readonly Stopwatch _sinceFail = new();

    /// <summary>Raised (on the caller's thread) after a chunk is accepted; arg = events sent.</summary>
    public event Action<int>? Sent;
    /// <summary>Raised after a failed POST; args = HTTP status (0 = network error), message.</summary>
    public event Action<int, string>? Failed;

    public int QueueCount => _queue.Count;

    public BatchSender(AgentConfig cfg)
    {
        _client = new ApiClient(cfg.Server, cfg.Token);
    }

    public void Enqueue(CaptureEvent ev)
    {
        long size = ApproxBytes(ev);
        _queue.Add(ev);
        _queueBytes += size;
        DropOldestIfOverCap();

        if (_queue.Count >= FlushCountThreshold) MaybeFlush();
    }

    public void MaybeFlush()
    {
        if (_queue.Count == 0) return;
        if (_sinceFlush.ElapsedMilliseconds < FlushIntervalMs && _queue.Count < FlushCountThreshold)
            return;
        // Respect backoff after a failure.
        if (_backoffMs > 0 && _sinceFail.IsRunning && _sinceFail.ElapsedMilliseconds < _backoffMs)
            return;
        FlushNow();
    }

    public void FlushNow()
    {
        if (_queue.Count == 0) return;

        // Send in chunks of at most MaxPerRequest; stop on first failure.
        while (_queue.Count > 0)
        {
            int take = Math.Min(MaxPerRequest, _queue.Count);
            var chunk = _queue.GetRange(0, take);

            int status;
            string error = "";
            try { status = _client.PostCaptureAsync(chunk).GetAwaiter().GetResult(); }
            catch (Exception ex) { status = 0; error = ex.Message; }

            if (status < 200 || status >= 300)
            {
                OnFailure();
                Failed?.Invoke(status, status == 0 ? "network error: " + error : $"server returned HTTP {status}");
                return; // keep queue, retry later with backoff
            }

            // success: drop the sent chunk
            foreach (var ev in chunk) _queueBytes -= ApproxBytes(ev);
            _queue.RemoveRange(0, take);
            OnSuccess();
            Sent?.Invoke(take);
        }
    }

    private void OnSuccess()
    {
        _sinceFlush.Restart();
        _backoffMs = 0;
        _sinceFail.Reset();
    }

    private void OnFailure()
    {
        _sinceFlush.Restart();
        _backoffMs = _backoffMs == 0 ? 2_000 : Math.Min(_backoffMs * 2, 300_000);
        _sinceFail.Restart();
        Console.Error.WriteLine($"capture POST failed; {_queue.Count} events queued, retry in {_backoffMs / 1000}s");
    }

    private void DropOldestIfOverCap()
    {
        while (_queueBytes > MaxQueueBytes && _queue.Count > 0)
        {
            _queueBytes -= ApproxBytes(_queue[0]);
            _queue.RemoveAt(0);
        }
    }

    private static long ApproxBytes(CaptureEvent ev)
    {
        // Rough: dominated by text.
        long n = 128; // overhead for keys + other fields
        n += Encoding.UTF8.GetByteCount(ev.Text ?? "");
        n += Encoding.UTF8.GetByteCount(ev.Window ?? "");
        n += Encoding.UTF8.GetByteCount(ev.App ?? "");
        n += Encoding.UTF8.GetByteCount(ev.Url ?? "");
        return n;
    }
}
