import Foundation

public struct CaptureEvent: Codable {
    public let app: String
    public let bundleId: String?
    public let window: String
    public let url: String?
    public let text: String
    public let capturedAt: String

    public init(app: String, bundleId: String?, window: String, url: String?, text: String, capturedAt: String) {
        self.app = app
        self.bundleId = bundleId
        self.window = window
        self.url = url
        self.text = text
        self.capturedAt = capturedAt
    }

    public func encode(to encoder: Encoder) throws {  // emit explicit nulls
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(app, forKey: .app)
        try c.encode(bundleId, forKey: .bundleId)
        try c.encode(window, forKey: .window)
        try c.encode(url, forKey: .url)
        try c.encode(text, forKey: .text)
        try c.encode(capturedAt, forKey: .capturedAt)
    }
}

/// Synchronous HTTP helper (callers run it off the main thread; requests have short timeouts).
public func httpJSON(_ method: String, _ url: URL, token: String?, body: Data?, timeout: TimeInterval = 15) -> (Int, Data?, Error?) {
    var req = URLRequest(url: url, timeoutInterval: timeout)
    req.httpMethod = method
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    req.httpBody = body
    let sem = DispatchSemaphore(value: 0)
    var result: (Int, Data?, Error?) = (0, nil, nil)
    URLSession.shared.dataTask(with: req) { data, resp, err in
        result = ((resp as? HTTPURLResponse)?.statusCode ?? 0, data, err)
        sem.signal()
    }.resume()
    sem.wait()
    return result
}

/// Outcome of one `maybeFlush` call that actually attempted an upload.
public struct FlushResult {
    public var sent = 0
    public var error: String?
    public var unauthorized = false
}

public final class Uploader {
    public let config: AgentConfig
    private var queue: [CaptureEvent] = []
    private var queueBytes = 0
    private let maxBytes = 5 * 1024 * 1024
    private let maxPerRequest = 200
    private let maxRequestBytes = 450 * 1024
    private var lastFlush = Date()
    private var failures = 0
    private var nextAttempt = Date.distantPast

    public init(config: AgentConfig) { self.config = config }

    public var queuedCount: Int { queue.count }

    public func enqueue(_ e: CaptureEvent) {
        queue.append(e)
        queueBytes += e.text.utf8.count + 200
        var dropped = 0
        while queueBytes > maxBytes, !queue.isEmpty {
            queueBytes -= queue.removeFirst().text.utf8.count + 200
            dropped += 1
        }
        if dropped > 0 { log("queue over 5MB, dropped \(dropped) oldest events") }
    }

    /// Uploads queued events if it's time (20s since last flush, or >100 queued). Returns nil if nothing was attempted.
    @discardableResult
    public func maybeFlush() -> FlushResult? {
        guard !queue.isEmpty, Date() >= nextAttempt else { return nil }
        guard queue.count > 100 || Date().timeIntervalSince(lastFlush) >= 20 else { return nil }
        lastFlush = Date()
        var result = FlushResult()
        while !queue.isEmpty {
            // build a batch under count and size limits
            var batch: [CaptureEvent] = []
            var bytes = 0
            for e in queue.prefix(maxPerRequest) {
                let sz = e.text.utf8.count + 200
                if !batch.isEmpty && bytes + sz > maxRequestBytes { break }
                batch.append(e); bytes += sz
            }
            guard let body = try? JSONEncoder().encode(["events": batch]),
                  let url = URL(string: config.server.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/api/capture")
            else { result.error = "bad server URL"; return result }
            let (status, _, err) = httpJSON("POST", url, token: config.token, body: body)
            if (200..<300).contains(status) {
                queue.removeFirst(batch.count)
                queueBytes = queue.reduce(0) { $0 + $1.text.utf8.count + 200 }
                failures = 0
                result.sent += batch.count
                log("sent \(batch.count) events (\(bytes / 1024) KB), \(queue.count) queued")
            } else if status == 413 || status == 400 {
                // payload rejected; drop it rather than retry forever
                queue.removeFirst(batch.count)
                queueBytes = queue.reduce(0) { $0 + $1.text.utf8.count + 200 }
                result.error = "server rejected batch (HTTP \(status))"
                log("server rejected batch (HTTP \(status)); dropped \(batch.count) events")
            } else {
                failures += 1
                let delay = min(300.0, 20.0 * pow(2.0, Double(failures - 1)))
                nextAttempt = Date().addingTimeInterval(delay)
                let why = status == 401 ? "unauthorized (run login again)" : (err?.localizedDescription ?? "HTTP \(status)")
                result.error = status == 401 ? "Session expired. Sign in again." : "Upload failed: \(why)"
                result.unauthorized = status == 401
                log("upload failed: \(why); \(queue.count) queued, retry in \(Int(delay))s")
                return result
            }
        }
        return result
    }
}
