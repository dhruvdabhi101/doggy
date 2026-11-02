using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

namespace DoggyAgent;

/// <summary>Result of reading a single foreground window.</summary>
public sealed class CaptureResult
{
    public string App = "";        // process display name, e.g. "chrome"
    public string? BundleId;       // windows exe name, e.g. "chrome.exe"
    public string Window = "";     // window title
    public string? Url;            // browser address bar, if found
    public string Text = "";       // full extracted text (all lines, before diff)
    public bool Skipped;           // excluded app / password / nothing
    public string? SkipReason;
}

/// <summary>
/// Reads on-screen text from the foreground window via Windows UI Automation
/// (no screenshots, no OCR). Must be called on an STA thread.
/// </summary>
public static class UiaCapturer
{
    // --- limits / budget ---
    private const int MaxNodes = 3000;
    private const int MaxDepth = 40;
    private const int BudgetMs = 500;

    // Default apps we never read (credential managers / lock screens).
    private static readonly string[] DefaultExclude =
    {
        "1password", "bitwarden", "keepass", "credentialuifirefox",
        "logonui", "lockapp",
    };

    // Apps whose UIA tree is a Chromium/Electron renderer.
    private static readonly string[] ChromiumApps =
    {
        "chrome", "msedge", "slack", "teams", "ms-teams", "whatsapp", "discord",
        "brave", "opera", "code",
    };

    // Control types whose text we keep.
    private static readonly HashSet<int> WantedControlTypes = new()
    {
        ControlType.Text.Id,
        ControlType.Edit.Id,
        ControlType.Document.Id,
        ControlType.Hyperlink.Id,
        ControlType.ListItem.Id,
        ControlType.DataItem.Id,
        ControlType.Header.Id,
    };

    #region P/Invoke
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);
    #endregion

    public static string ForegroundWindowTitle(IntPtr hwnd)
    {
        try
        {
            int len = GetWindowTextLength(hwnd);
            if (len <= 0) return "";
            var sb = new StringBuilder(len + 1);
            GetWindowTextW(hwnd, sb, sb.Capacity);
            return sb.ToString();
        }
        catch { return ""; }
    }

    private static string ProcessName(IntPtr hwnd)
    {
        try
        {
            GetWindowThreadProcessId(hwnd, out uint pid);
            if (pid == 0) return "";
            using var p = Process.GetProcessById((int)pid);
            return p.ProcessName; // e.g. "chrome" (no .exe)
        }
        catch { return ""; }
    }

    /// <summary>Capture the current foreground window once. Never throws.</summary>
    public static CaptureResult CaptureForeground(IReadOnlyCollection<string> extraExclude)
    {
        var result = new CaptureResult();
        try
        {
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero)
            {
                result.Skipped = true;
                result.SkipReason = "no foreground window";
                return result;
            }

            string proc = ProcessName(hwnd);
            result.App = proc;
            result.BundleId = string.IsNullOrEmpty(proc) ? null : proc + ".exe";
            result.Window = ForegroundWindowTitle(hwnd);

            var procLower = proc.ToLowerInvariant();
            if (IsExcluded(procLower, extraExclude))
            {
                result.Skipped = true;
                result.SkipReason = "excluded app";
                return result;
            }

            AutomationElement? root = null;
            try { root = AutomationElement.FromHandle(hwnd); }
            catch (ElementNotAvailableException) { }
            catch (COMException) { }
            catch (ArgumentException) { }

            if (root is null)
            {
                result.Skipped = true;
                result.SkipReason = "no automation element";
                return result;
            }

            var cache = BuildCacheRequest();
            var lines = new List<string>();
            string? url = null;
            bool isChromium = ChromiumApps.Contains(procLower);

            using (cache.Activate())
            {
                AutomationElement cachedRoot;
                try { cachedRoot = root.GetUpdatedCache(cache); }
                catch { cachedRoot = root; }

                var sw = Stopwatch.StartNew();
                int nodeCount = 0;
                WalkTree(cachedRoot, cache, 0, lines, ref nodeCount, sw, ref url);
            }

            result.Url = url;
            result.Text = string.Join("\n", lines);
            if (result.Text.Trim().Length == 0)
            {
                result.Skipped = true;
                result.SkipReason = "no text";
            }
            return result;
        }
        catch (Exception ex)
        {
            result.Skipped = true;
            result.SkipReason = "error: " + ex.GetType().Name;
            return result;
        }
    }

    public static bool IsDefaultExcluded(string processName) =>
        DefaultExclude.Any(e => processName.Contains(e, StringComparison.OrdinalIgnoreCase));

    private static bool IsExcluded(string procLower, IReadOnlyCollection<string> extra)
    {
        if (string.IsNullOrEmpty(procLower)) return false;
        foreach (var e in DefaultExclude)
            if (procLower.Contains(e)) return true;
        foreach (var e in extra)
            if (!string.IsNullOrWhiteSpace(e) && procLower.Contains(e.ToLowerInvariant()))
                return true;
        return false;
    }

    private static CacheRequest BuildCacheRequest()
    {
        var cache = new CacheRequest
        {
            TreeScope = TreeScope.Element,
            TreeFilter = Automation.ControlViewCondition,
            AutomationElementMode = AutomationElementMode.None, // lighter; we only read cached props
        };
        cache.Add(AutomationElement.NameProperty);
        cache.Add(AutomationElement.ControlTypeProperty);
        cache.Add(AutomationElement.IsPasswordProperty);
        cache.Add(AutomationElement.AutomationIdProperty);
        try { cache.Add(ValuePattern.Pattern); } catch { }
        try { cache.Add(ValuePattern.ValueProperty); } catch { }
        return cache;
    }

    private static void WalkTree(
        AutomationElement element, CacheRequest cache, int depth,
        List<string> lines, ref int nodeCount, Stopwatch sw, ref string? url)
    {
        if (depth > MaxDepth || nodeCount >= MaxNodes || sw.ElapsedMilliseconds > BudgetMs)
            return;

        nodeCount++;
        CollectText(element, lines, ref url);

        AutomationElement? child;
        try { child = TreeWalker.ControlViewWalker.GetFirstChild(element, cache); }
        catch { return; }

        while (child is not null)
        {
            if (nodeCount >= MaxNodes || sw.ElapsedMilliseconds > BudgetMs) return;
            WalkTree(child, cache, depth + 1, lines, ref nodeCount, sw, ref url);
            try { child = TreeWalker.ControlViewWalker.GetNextSibling(child, cache); }
            catch { break; }
        }
    }

    private static void CollectText(AutomationElement element, List<string> lines, ref string? url)
    {
        try
        {
            // Skip anything that is (or claims to be) a password field.
            object? pw = SafeCached(element, AutomationElement.IsPasswordProperty);
            if (pw is true) return;

            int ctId;
            try { ctId = element.Cached.ControlType?.Id ?? 0; } catch { return; }
            if (!WantedControlTypes.Contains(ctId)) return;

            string name = (SafeCached(element, AutomationElement.NameProperty) as string) ?? "";
            string value = (SafeCached(element, ValuePattern.ValueProperty) as string) ?? "";
            string autoId = (SafeCached(element, AutomationElement.AutomationIdProperty) as string) ?? "";

            // Browser address bar heuristic -> url.
            if (url is null && ctId == ControlType.Edit.Id && LooksLikeAddressBar(name, autoId))
            {
                var candidate = !string.IsNullOrWhiteSpace(value) ? value : name;
                if (LooksLikeUrl(candidate)) url = candidate.Trim();
            }

            if (!string.IsNullOrWhiteSpace(value)) lines.Add(value);
            else if (!string.IsNullOrWhiteSpace(name)) lines.Add(name);
        }
        catch (ElementNotAvailableException) { }
        catch (COMException) { }
        catch { }
    }

    private static object? SafeCached(AutomationElement element, AutomationProperty prop)
    {
        try { return element.GetCachedPropertyValue(prop); }
        catch { return null; }
    }

    private static bool LooksLikeAddressBar(string name, string autoId)
    {
        var n = name.ToLowerInvariant();
        var a = autoId.ToLowerInvariant();
        return n.Contains("address") || n.Contains("search bar") || n.Contains("location")
               || a.Contains("urlbar") || a.Contains("address");
    }

    private static bool LooksLikeUrl(string s)
    {
        s = s.Trim();
        if (s.Length < 3) return false;
        return s.StartsWith("http://") || s.StartsWith("https://")
               || s.Contains('.') && !s.Contains(' ');
    }
}
