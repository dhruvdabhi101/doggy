import Combine
import Foundation

public struct CapturedApp: Equatable {
    public let name: String
    public let bundleId: String?
}

public enum CaptureState: Equatable {
    case stopped, running, paused, needsPermission, notLoggedIn
}

/// Capture loop for the GUI: every `interval` seconds it re-reads the config, checks Accessibility permission and the
/// pause file, captures the frontmost window and uploads new lines. Work runs on a private serial queue; the
/// published properties are updated on the main thread.
///
/// Because config, permission and pause state are re-checked on every tick, it starts capturing on its own once the
/// user signs in or grants permission, and it follows `doggy-agent login` / `touch ~/.doggy/paused` from the CLI.
public final class CaptureEngine: ObservableObject {
    @Published public private(set) var state: CaptureState = .stopped
    @Published public private(set) var lastUpload: Date?
    @Published public private(set) var eventsSentToday = 0
    @Published public private(set) var lastError: String?
    /// The last app whose window was read, so the menu can offer to stop capturing it.
    @Published public private(set) var lastApp: CapturedApp?

    public let interval: TimeInterval
    private let queue = DispatchQueue(label: "world.ruv.doggy.capture", qos: .utility)
    private var timer: DispatchSourceTimer?  // main thread only

    // Confined to `queue`.
    private lazy var capture = AXCapture()
    private let differ = Differ()
    private var uploader: Uploader?
    private let iso = ISO8601DateFormatter()
    private var countDay = Calendar.current.startOfDay(for: Date())
    private var count = 0

    public init(interval: TimeInterval = 3) { self.interval = interval }

    public var isStarted: Bool { timer != nil }

    public func start() {
        guard timer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: interval, leeway: .milliseconds(500))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    public func stop() {
        timer?.cancel()
        timer = nil
        queue.async { [weak self] in
            _ = self?.uploader?.maybeFlush()
            self?.publish { $0.state = .stopped }
        }
    }

    public func pause() { setPaused(true); refresh() }
    public func resume() { setPaused(false); refresh() }

    /// Re-evaluate state now (after sign-in, sign-out, permission grant...) instead of waiting for the next tick.
    public func refresh() {
        guard timer != nil else { return }
        queue.async { [weak self] in self?.tick() }
    }

    private func publish(_ change: @escaping (CaptureEngine) -> Void) {
        DispatchQueue.main.async { [weak self] in if let self { change(self) } }
    }

    private func tick() {
        let cfg = AgentConfig.load().flatMap { $0.isSignedIn ? $0 : nil }
        if uploader?.config != cfg {
            uploader = cfg.map(Uploader.init)
        }
        guard let cfg, let uploader else {
            publish { if $0.state != .notLoggedIn { $0.state = .notLoggedIn; $0.lastError = nil } }
            return
        }
        guard checkAccessibility(prompt: false) else {
            publish { if $0.state != .needsPermission { $0.state = .needsPermission } }
            handle(uploader.maybeFlush())
            return
        }
        if isPaused {
            publish { if $0.state != .paused { $0.state = .paused } }
        } else {
            publish { if $0.state != .running { $0.state = .running } }
            if let snap = capture.frontmost(exclude: cfg.excludeApps ?? []) {
                let app = CapturedApp(name: snap.app, bundleId: snap.bundleId)
                publish { if $0.lastApp != app { $0.lastApp = app } }
                let key = (snap.bundleId ?? snap.app) + "\u{1}" + snap.window
                let fresh = differ.newLines(key: key, lines: snap.lines)
                if !fresh.isEmpty {
                    uploader.enqueue(CaptureEvent(app: snap.app, bundleId: snap.bundleId, window: snap.window,
                                                  url: snap.url, text: fresh.joined(separator: "\n"),
                                                  capturedAt: iso.string(from: Date())))
                }
            }
        }
        handle(uploader.maybeFlush())
    }

    private func handle(_ r: FlushResult?) {
        guard let r else { return }
        let today = Calendar.current.startOfDay(for: Date())
        if today != countDay { countDay = today; count = 0 }
        count += r.sent
        let total = count
        let now = Date()
        publish {
            if r.sent > 0 { $0.lastUpload = now }
            if $0.eventsSentToday != total { $0.eventsSentToday = total }
            if $0.lastError != r.error { $0.lastError = r.error }
        }
    }
}
