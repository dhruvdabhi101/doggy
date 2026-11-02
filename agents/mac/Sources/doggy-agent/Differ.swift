import Foundation

/// Per-window memory of lines already sent. LRU over windows, capped lines per window.
final class Differ {
    private let maxWindows = 200
    private let maxLines = 5000
    private var seen: [String: (set: Set<Int>, order: [Int])] = [:]
    private var lru: [String] = []

    private static let junk = try! NSRegularExpression(
        pattern: #"^[\d\s.,:;/\-+()%]*(am|pm|AM|PM)?[\d\s.,:;/\-+()%]*$"#)

    static func normalize(_ line: String) -> String? {
        let s = line.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        if s.count < 3 { return nil }
        let r = NSRange(s.startIndex..., in: s)
        if junk.firstMatch(in: s, range: r) != nil { return nil }
        return s
    }

    /// Returns only lines not previously sent for this window, and records them as sent.
    func newLines(key: String, lines: [String]) -> [String] {
        var entry = seen[key] ?? (Set<Int>(), [])
        var out: [String] = []
        for raw in lines {
            guard let n = Self.normalize(raw) else { continue }
            let h = n.hashValue
            if entry.set.contains(h) { continue }
            entry.set.insert(h)
            entry.order.append(h)
            out.append(n)
        }
        if entry.order.count > maxLines {
            let drop = entry.order.count - maxLines
            for h in entry.order.prefix(drop) { entry.set.remove(h) }
            entry.order.removeFirst(drop)
        }
        seen[key] = entry
        if let i = lru.firstIndex(of: key) { lru.remove(at: i) }
        lru.append(key)
        while lru.count > maxWindows { seen.removeValue(forKey: lru.removeFirst()) }
        return out
    }
}
