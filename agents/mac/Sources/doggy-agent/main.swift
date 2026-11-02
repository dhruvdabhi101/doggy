import AppKit
import Foundation

let usage = """
usage:
  doggy-agent login --server URL --email E --password P [--device-name N]
  doggy-agent run [--dry-run] [--once] [--interval SECONDS]
  doggy-agent status
"""

func flag(_ args: [String], _ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

let accessibilityHelp = """
Accessibility permission is NOT granted to this process.
  1. Open System Settings -> Privacy & Security -> Accessibility
  2. Click + and add the doggy-agent binary (or the terminal app you run it from), and enable it
  3. Re-run this command (a restart of the terminal may be required)
"""

func cmdLogin(_ args: [String]) {
    guard let server = flag(args, "--server"), let email = flag(args, "--email"),
          let password = flag(args, "--password") else { fail(usage) }
    let deviceName = flag(args, "--device-name") ?? Host.current().localizedName ?? "Mac"
    let base = server.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard let url = URL(string: base + "/api/auth/login") else { fail("bad server URL") }
    let body = try! JSONSerialization.data(withJSONObject: [
        "email": email, "password": password, "deviceName": deviceName, "deviceKind": "mac-agent",
    ])
    let (status, data, err) = httpJSON("POST", url, token: nil, body: body)
    guard (200..<300).contains(status), let data,
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let token = obj["token"] as? String else {
        let detail = data.flatMap { String(data: $0, encoding: .utf8) } ?? err?.localizedDescription ?? ""
        fail("login failed (HTTP \(status)): \(detail)")
    }
    let existing = AgentConfig.load()
    do {
        try AgentConfig(server: base, token: token, excludeApps: existing?.excludeApps).save()
    } catch { fail("could not save config: \(error)") }
    print("logged in as \(email); device \"\(deviceName)\"; saved \(Paths.config.path)")
}

func cmdStatus() {
    let cfg = AgentConfig.load()
    print("config:        \(Paths.config.path) \(cfg == nil ? "(missing - run login)" : "")")
    if let cfg {
        print("server:        \(cfg.server)")
        print("token:         \(cfg.token.isEmpty ? "missing" : "present")")
        print("excludeApps:   \((cfg.excludeApps ?? []).joined(separator: ", "))")
    }
    print("accessibility: \(checkAccessibility(prompt: false) ? "granted" : "NOT granted")")
    print("paused:        \(isPaused ? "yes (\(Paths.paused.path) exists)" : "no")")
}

func cmdRun(_ args: [String]) {
    let dryRun = args.contains("--dry-run")
    let once = args.contains("--once")
    let interval = flag(args, "--interval").flatMap(Double.init) ?? 3.0

    let cfg = AgentConfig.load()
    if !dryRun && cfg == nil { fail("not logged in; run: doggy-agent login --server URL --email E --password P") }

    if !checkAccessibility(prompt: true) {
        log(accessibilityHelp)
        if once { exit(2) }
        log("waiting for permission...")
        while !checkAccessibility(prompt: false) { RunLoop.current.run(until: Date().addingTimeInterval(5)) }
        log("accessibility granted")
    }

    let capture = AXCapture()
    let differ = Differ()
    let uploader = cfg.map { Uploader(config: $0) }
    let iso = ISO8601DateFormatter()
    let exclude = cfg?.excludeApps ?? []
    let jsonEnc = JSONEncoder()
    jsonEnc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    var wasPaused = false
    log("doggy-agent running (\(dryRun ? "dry-run" : cfg!.server), every \(interval)s)")

    while true {
        // pump the run loop so NSWorkspace sees app activation changes
        if !once { RunLoop.current.run(until: Date().addingTimeInterval(interval)) }

        if isPaused {
            if !wasPaused { log("paused (\(Paths.paused.path) exists)"); wasPaused = true }
        } else {
            if wasPaused { log("resumed"); wasPaused = false }
            let t0 = Date()
            if let snap = capture.frontmost(exclude: exclude) {
                let key = (snap.bundleId ?? snap.app) + "\u{1}" + snap.window
                let fresh = differ.newLines(key: key, lines: snap.lines)
                if !fresh.isEmpty {
                    let ev = CaptureEvent(app: snap.app, bundleId: snap.bundleId, window: snap.window,
                                          url: snap.url, text: fresh.joined(separator: "\n"),
                                          capturedAt: iso.string(from: Date()))
                    if dryRun {
                        if let d = try? jsonEnc.encode(ev), let s = String(data: d, encoding: .utf8) { print(s) }
                        fflush(stdout)
                    } else {
                        uploader?.enqueue(ev)
                    }
                }
                if dryRun || once {
                    log("\(snap.app) / \"\(snap.window)\": \(snap.lines.count) lines, \(fresh.count) new, \(Int(Date().timeIntervalSince(t0) * 1000))ms")
                }
            } else if once {
                log("nothing captured (no focused window, excluded app, or AX tree unavailable)")
            }
        }
        if !dryRun { uploader?.maybeFlush() }
        if once { break }
    }
}

setvbuf(stdout, nil, _IOLBF, 0)
let argv = Array(CommandLine.arguments.dropFirst())
switch argv.first {
case "login": cmdLogin(argv)
case "run": cmdRun(argv)
case "status": cmdStatus()
default: fail(usage)
}
