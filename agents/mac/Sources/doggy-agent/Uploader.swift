import Foundation

struct CaptureEvent: Codable {
    let app: String
    let bundleId: String?
    let window: String
    let url: String?
    let text: String
    let capturedAt: String

    func encode(to encoder: Encoder) throws {  // emit explicit nulls
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(app, forKey: .app)
        try c.encode(bundleId, forKey: .bundleId)
        try c.encode(window, forKey: .window)
        try c.encode(url, forKey: .url)
        try c.encode(text, forKey: .text)
        try c.encode(capturedAt, forKey: .capturedAt)
    }
}

/// Synchronous HTTP helper (agent is single-threaded; requests have short timeouts).
func httpJSON(_ method: String, _ url: URL, token: String?, body: Data?, timeout: TimeInterval = 15) -> (Int, Data?, Error?) {
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

final class Uploader {
    let config: AgentConfig
    private var queue: [CaptureEvent] = []
    private var queueBytes = 0
    private let maxBytes = 5 * 1024 * 1024
    private let maxPerRequest = 200
    private let maxRequestBytes = 450 * 1024
    private var lastFlush = Date()
    private var failures = 0
    private var nextAttempt = Date.distantPast

    init(config: AgentConfig) { self.config = config }

    func enqueue(_ e: CaptureEvent) {
        queue.append(e)
        queueBytes += e.text.utf8.count + 200
        var dropped = 0
        while queueBytes > maxBytes, !queue.isEmpty {
            queueBytes -= queue.removeFirst().text.utf8.count + 200
            dropped += 1
        }
        if dropped > 0 { log("queue over 5MB, dropped \(dropped) oldest events") }
    }

    func maybeFlush() {
        guard !queue.isEmpty, Date() >= nextAttempt else { return }
        guard queue.count > 100 || Date().timeIntervalSince(lastFlush) >= 20 else { return }
        lastFlush = Date()
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
            else { return }
            let (status, _, err) = httpJSON("POST", url, token: config.token, body: body)
            if (200..<300).contains(status) {
                queue.removeFirst(batch.count)
                queueBytes = queue.reduce(0) { $0 + $1.text.utf8.count + 200 }
                failures = 0
                log("sent \(batch.count) events (\(bytes / 1024) KB), \(queue.count) queued")
            } else if status == 413 || status == 400 {
                // payload rejected; drop it rather than retry forever
                queue.removeFirst(batch.count)
                log("server rejected batch (HTTP \(status)); dropped \(batch.count) events")
            } else {
                failures += 1
                let delay = min(300.0, 20.0 * pow(2.0, Double(failures - 1)))
                nextAttempt = Date().addingTimeInterval(delay)
                let why = status == 401 ? "unauthorized (run login again)" : (err?.localizedDescription ?? "HTTP \(status)")
                log("upload failed: \(why); \(queue.count) queued, retry in \(Int(delay))s")
                return
            }
        }
    }
}
