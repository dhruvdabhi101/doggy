import AppKit
import Combine
import DoggyCore
import ServiceManagement
import SwiftUI

@main
struct DoggyApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @ObservedObject private var model = AppModel.shared
    @ObservedObject private var engine = AppModel.shared.engine

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model, engine: engine)
        } label: {
            Image(systemName: engine.state == .running ? "pawprint.fill" : "pawprint")
                .accessibilityLabel("Doggy")
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // LSUIElement covers the bundled app; this also hides the Dock icon for `swift run DoggyApp`.
        NSApp.setActivationPolicy(.accessory)
        AppModel.shared.launched()
    }

    func applicationWillTerminate(_ notification: Notification) {
        AppModel.shared.engine.stop()
    }
}

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    let engine = CaptureEngine()
    @Published var now = Date()
    private var windows: [String: NSWindow] = [:]
    private var clock: Timer?

    var config: AgentConfig? { AgentConfig.load() }
    var isSignedIn: Bool { config?.isSignedIn ?? false }
    var serverURL: String { config?.server ?? AgentConfig.defaultServer }

    func launched() {
        engine.start()
        // keeps "last sync 2m ago" fresh
        clock = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.now = Date() }
        }
        if !isSignedIn { showSignIn() }
    }

    // MARK: actions

    func grantAccessibility() {
        _ = checkAccessibility(prompt: true)
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    func openDoggy() {
        if let url = URL(string: serverURL) { NSWorkspace.shared.open(url) }
    }

    func togglePause() {
        if isPaused { engine.resume() } else { engine.pause() }
        objectWillChange.send()
    }

    func signOut() {
        DoggyAPI.signOut()
        close("note")
        engine.refresh()
        objectWillChange.send()
    }

    func didSignIn() {
        close("signin")
        engine.refresh()
        objectWillChange.send()
        if !checkAccessibility(prompt: false) { grantAccessibility() }
    }

    var startsAtLogin: Bool {
        get { SMAppService.mainApp.status == .enabled }
        set {
            do {
                if newValue { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            } catch {
                let alert = NSAlert()
                alert.messageText = "Couldn't change Start at login"
                alert.informativeText = error.localizedDescription
                NSApp.activate(ignoringOtherApps: true)
                alert.runModal()
            }
            objectWillChange.send()
        }
    }

    // MARK: windows

    func showSignIn() {
        show("signin", title: "Sign in to Doggy") { SignInView(model: self) }
    }

    func showQuickNote() {
        guard isSignedIn else { return showSignIn() }
        show("note", title: "Quick note") { QuickNoteView(model: self) }
    }

    func close(_ id: String) { windows[id]?.close() }

    private func show<V: View>(_ id: String, title: String, @ViewBuilder content: () -> V) {
        NSApp.activate(ignoringOtherApps: true)
        if let w = windows[id] { w.makeKeyAndOrderFront(nil); return }
        let w = NSWindow(contentViewController: NSHostingController(rootView: content()))
        w.title = title
        w.styleMask = [.titled, .closable]
        w.isReleasedWhenClosed = false
        w.center()
        windows[id] = w
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: w, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.windows[id] = nil }
        }
        w.makeKeyAndOrderFront(nil)
    }
}

// MARK: - Menu

struct MenuContent: View {
    @ObservedObject var model: AppModel
    @ObservedObject var engine: CaptureEngine

    private var statusLine: String {
        switch engine.state {
        case .stopped: return "Starting…"
        case .notLoggedIn: return "Not signed in"
        case .needsPermission: return "Needs Accessibility permission"
        case .paused: return "Paused"
        case .running:
            guard let last = engine.lastUpload else { return "Capturing · not synced yet" }
            if model.now.timeIntervalSince(last) < 60 { return "Capturing · last sync just now" }
            let f = RelativeDateTimeFormatter()
            f.unitsStyle = .abbreviated
            return "Capturing · last sync \(f.localizedString(for: last, relativeTo: model.now))"
        }
    }

    var body: some View {
        Text(statusLine)
        if engine.eventsSentToday > 0 {
            Text("\(engine.eventsSentToday) events sent today")
        }
        if let err = engine.lastError {
            Text(err)
        }
        Divider()

        if model.isSignedIn {
            Button("Quick note…") { model.showQuickNote() }
                .keyboardShortcut("n")
            Button(isPaused ? "Resume capture" : "Pause capture") { model.togglePause() }
                .keyboardShortcut("p")
        } else {
            Button("Sign in…") { model.showSignIn() }
        }
        Button("Open Doggy") { model.openDoggy() }
            .keyboardShortcut("o")
        if engine.state == .needsPermission {
            Button("Grant Accessibility…") { model.grantAccessibility() }
        }
        Divider()

        Toggle("Start at login", isOn: Binding(get: { model.startsAtLogin }, set: { model.startsAtLogin = $0 }))
        if model.isSignedIn {
            Button("Sign out") { model.signOut() }
        }
        Divider()
        Button("Quit Doggy") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}
