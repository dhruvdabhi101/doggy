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
