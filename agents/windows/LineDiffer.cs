using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace DoggyAgent;

/// <summary>
/// Agent-side diff. Per (processName + window title) key it remembers hashes of
/// already-sent normalized lines, so only new lines are ever shipped.
/// Bounded: at most MaxWindows window keys (LRU), MaxLinesPerWindow hashes each.
/// </summary>
public sealed class LineDiffer
{
    private const int MaxWindows = 200;
    private const int MaxLinesPerWindow = 5000;

    // key -> set of sent line hashes (insertion order preserved for per-window trimming)
    private readonly Dictionary<string, LinkedHashSet> _byWindow = new();
    // LRU order of window keys (most-recent at the end)
    private readonly LinkedList<string> _lru = new();

    private static readonly Regex Whitespace = new(@"\s+", RegexOptions.Compiled);
    private static readonly Regex PureNumberOrTime = new(
        @"^[\d\s:/.,\-]+$", RegexOptions.Compiled);

    /// <summary>
    /// Given the full raw text of a window, return only the lines that are new
    /// for this window key, joined by "\n". Empty string if nothing new.
    /// </summary>
    public string Diff(string windowKey, string rawText)
    {
        var set = Touch(windowKey);
        var sb = new StringBuilder();

        foreach (var rawLine in rawText.Split('\n'))
        {
            var norm = Normalize(rawLine);
            if (norm.Length == 0) continue;

            var hash = Hash(norm);
            if (set.Contains(hash)) continue;

            set.Add(hash);
            if (sb.Length > 0) sb.Append('\n');
            sb.Append(norm);
        }

        // Trim per-window memory (drop oldest hashes).
        set.TrimTo(MaxLinesPerWindow);
        return sb.ToString();
    }

    /// <summary>trim, collapse whitespace, drop lines &lt;3 chars and pure numbers/timestamps.</summary>
    public static string Normalize(string line)
    {
        var s = Whitespace.Replace(line, " ").Trim();
        if (s.Length < 3) return "";
        if (PureNumberOrTime.IsMatch(s)) return "";
        return s;
    }

    private LinkedHashSet Touch(string key)
    {
        if (_byWindow.TryGetValue(key, out var existing))
        {
            _lru.Remove(key);
            _lru.AddLast(key);
            return existing;
        }

        if (_byWindow.Count >= MaxWindows)
        {
            var oldest = _lru.First;
            if (oldest is not null)
            {
                _byWindow.Remove(oldest.Value);
                _lru.RemoveFirst();
            }
        }

        var set = new LinkedHashSet();
        _byWindow[key] = set;
        _lru.AddLast(key);
        return set;
    }

    private static string Hash(string s)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(s));
        // 8 bytes is plenty for dedupe within one window.
        return Convert.ToHexString(bytes, 0, 8);
    }
}

/// <summary>Insertion-ordered hash set with cheap oldest-first trimming.</summary>
public sealed class LinkedHashSet
{
    private readonly HashSet<string> _set = new();
    private readonly Queue<string> _order = new();

    public bool Contains(string h) => _set.Contains(h);

    public void Add(string h)
    {
        if (_set.Add(h)) _order.Enqueue(h);
    }

    public void TrimTo(int max)
    {
        while (_set.Count > max && _order.Count > 0)
        {
            var old = _order.Dequeue();
            _set.Remove(old);
        }
    }
}
