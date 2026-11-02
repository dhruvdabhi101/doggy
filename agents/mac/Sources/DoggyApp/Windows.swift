import AppKit
import DoggyCore
import SwiftUI

struct SignInView: View {
    let model: AppModel
    @State private var server = AgentConfig.load()?.server ?? AgentConfig.defaultServer
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?

    private var canSubmit: Bool { !busy && !email.isEmpty && !password.isEmpty && !server.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable().frame(width: 44, height: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Sign in to Doggy").font(.title3.weight(.semibold))
                    Text("Doggy reads text on screen and turns it into tasks.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }

            Form {
                TextField("Server", text: $server)
                TextField("Email", text: $email)
                    .textContentType(.username)
                SecureField("Password", text: $password)
                    .textContentType(.password)
            }
            .disabled(busy)

            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red).font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                if busy { ProgressView().controlSize(.small) }
                Spacer()
                Button("Create account") { submit(createAccount: true) }
                    .disabled(!canSubmit)
                Button("Sign in") { submit(createAccount: false) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSubmit)
            }
        }
        .padding(20)
        .frame(width: 380)
    }

    private func submit(createAccount: Bool) {
        busy = true
        error = nil
        Task { @MainActor in
            do {
                _ = try await DoggyAPI.signIn(server: server, email: email, password: password, createAccount: createAccount)
                busy = false
                model.didSignIn()
            } catch {
                busy = false
                self.error = error.localizedDescription
            }
        }
    }
}

struct QuickNoteView: View {
    let model: AppModel
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?
    @State private var items: [ExtractedItem]?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            TextField("Remind me to send Sam the deck by Friday…", text: $text, axis: .vertical)
                .lineLimit(3...8)
                .textFieldStyle(.roundedBorder)
                .disabled(busy)

            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red).font(.callout)
            }

            if let items {
                VStack(alignment: .leading, spacing: 6) {
                    Text(items.isEmpty ? "Saved. Nothing to extract." : "Saved. Extracted:")
                        .font(.callout.weight(.medium)).foregroundStyle(.secondary)
                    ForEach(items) { item in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: icon(item.type)).foregroundStyle(.tint).frame(width: 16)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(item.title)
                                if let sub = subtitle(item) {
                                    Text(sub).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
            }

            HStack {
                if busy { ProgressView().controlSize(.small) }
                Spacer()
                Button(items == nil ? "Cancel" : "Done") { model.close("note") }
                    .keyboardShortcut(.cancelAction)
                Button("Save") { send() }
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(16)
        .frame(width: 400)
    }

    private func send() {
        guard let cfg = model.config, cfg.isSignedIn else { return model.showSignIn() }
        let note = text.trimmingCharacters(in: .whitespacesAndNewlines)
        busy = true
        error = nil
        Task { @MainActor in
            do {
                items = try await DoggyAPI.postNote(note, config: cfg)
                text = ""
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }

    private func icon(_ type: String) -> String {
        switch type {
        case "task": return "checkmark.circle"
        case "commitment": return "hand.raised"
        case "decision": return "arrow.triangle.branch"
        case "event": return "calendar"
        default: return "brain"
        }
    }

    private func subtitle(_ item: ExtractedItem) -> String? {
        var parts: [String] = [item.type.capitalized]
        if let due = item.dueAt, let d = ISO8601DateFormatter().date(from: due) {
            parts.append("due " + d.formatted(date: .abbreviated, time: .shortened))
        }
        if let c = item.counterparty { parts.append(c) }
        return parts.joined(separator: " · ")
    }
}

struct ExcludedAppsView: View {
    @ObservedObject var model: AppModel
    @State private var entries = ExcludedApps.entries
    @State private var running: [NSRunningApplication] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Doggy never reads these apps. The change applies within a few seconds. Text already sent stays in your account until you delete it.")
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            List {
                if entries.isEmpty {
                    Text("No apps yet. Add one below.").foregroundStyle(.secondary)
                }
                ForEach(entries, id: \.self) { entry in
                    HStack(spacing: 10) {
                        Image(nsImage: icon(for: entry)).resizable().frame(width: 20, height: 20)
                        Text(displayName(for: entry))
                        Spacer()
                        Button("Remove") {
                            if (try? ExcludedApps.remove(entry)) != nil { reload() }
                        }
                        .buttonStyle(.link)
                    }
                }
            }
            .frame(minHeight: 160)

            HStack {
                Menu("Add a running app") {
                    ForEach(running, id: \.processIdentifier) { app in
                        Button(app.localizedName ?? app.bundleIdentifier ?? "Unknown") {
                            if model.setExcluded(true, name: app.localizedName ?? "", bundleId: app.bundleIdentifier) { reload() }
                        }
                    }
                }
                .fixedSize()
                Button("Choose app…") { chooseApp() }
                Spacer()
            }

            Text("Always ignored: password managers, Keychain Access, System Settings and the login screen. Password fields are never read in any app.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(20)
        .frame(width: 420)
        .onAppear(perform: reload)
        .onReceive(NotificationCenter.default.publisher(for: NSWorkspace.didLaunchApplicationNotification,
                                                       object: NSWorkspace.shared)) { _ in reload() }
    }

    private func reload() {
        entries = ExcludedApps.entries
        running = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular && $0.processIdentifier != getpid() }
            .filter { app in
                let name = app.localizedName ?? ""
                return !ExcludedApps.contains(name: name, bundleId: app.bundleIdentifier)
                    && !ExcludedApps.isDefault(name: name, bundleId: app.bundleIdentifier)
            }
            .sorted { ($0.localizedName ?? "").localizedCaseInsensitiveCompare($1.localizedName ?? "") == .orderedAscending }
    }

    private func chooseApp() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.application]
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.allowsMultipleSelection = true
        panel.prompt = "Ignore"
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK else { return }
        for url in panel.urls {
            let bundle = Bundle(url: url)
            let name = FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
            model.setExcluded(true, name: name, bundleId: bundle?.bundleIdentifier)
        }
        reload()
    }

    private func appURL(for entry: String) -> URL? {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: entry)
    }

    private func displayName(for entry: String) -> String {
        guard let url = appURL(for: entry) else { return entry }
        return FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
    }

    private func icon(for entry: String) -> NSImage {
        if let url = appURL(for: entry) { return NSWorkspace.shared.icon(forFile: url.path) }
        return NSWorkspace.shared.icon(for: .application)
    }
}
