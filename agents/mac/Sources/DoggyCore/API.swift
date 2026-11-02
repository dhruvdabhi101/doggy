import Foundation

public struct DoggyAPIError: LocalizedError {
    public let message: String
    public var errorDescription: String? { message }
}

/// An item extracted by the server (subset of the `Item` type in docs/API.md).
public struct ExtractedItem: Decodable, Identifiable {
    public let id: String
    public let type: String
    public let title: String
    public let details: String?
    public let dueAt: String?
    public let owner: String?
    public let counterparty: String?
}

/// Async calls used by the GUI. The CLI keeps its synchronous `httpJSON` path.
public enum DoggyAPI {
    public static func normalizedServer(_ server: String) -> String {
        var s = server.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        if !s.isEmpty && !s.contains("://") { s = "https://" + s }
        return s
    }

    static func post(_ base: String, _ path: String, token: String?, body: [String: Any]) async throws -> Data {
        guard let url = URL(string: base + path), url.host != nil else { throw DoggyAPIError(message: "Invalid server URL") }
        var req = URLRequest(url: url, timeoutInterval: 60)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let msg = (obj?["error"] as? String) ?? (obj?["message"] as? String)
                ?? String(data: data, encoding: .utf8).flatMap { $0.isEmpty || $0.count > 200 ? nil : $0 }
            if status == 401 && path.hasPrefix("/api/notes") { throw DoggyAPIError(message: "Session expired. Sign in again.") }
            throw DoggyAPIError(message: msg ?? "Request failed (HTTP \(status))")
        }
        return data
    }

    /// POST /api/auth/login or /api/auth/signup. Saves the token to ~/.doggy/agent.json and returns the config.
    public static func signIn(server: String, email: String, password: String, createAccount: Bool,
                              deviceName: String = Host.current().localizedName ?? "Mac") async throws -> AgentConfig {
        let base = normalizedServer(server)
        let data = try await post(base, createAccount ? "/api/auth/signup" : "/api/auth/login", token: nil, body: [
            "email": email, "password": password, "deviceName": deviceName, "deviceKind": "mac-agent",
        ])
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = obj["token"] as? String, !token.isEmpty else {
            throw DoggyAPIError(message: "Unexpected response from server")
        }
        let cfg = AgentConfig(server: base, token: token, excludeApps: AgentConfig.load()?.excludeApps)
        try cfg.save()
        return cfg
    }

    /// Keeps server and exclusions, clears the token.
    public static func signOut() {
        guard var cfg = AgentConfig.load() else { return }
        cfg.token = ""
        try? cfg.save()
    }

    /// POST /api/notes {text, source:"text"} -> extracted items (extraction is synchronous).
    public static func postNote(_ text: String, config: AgentConfig) async throws -> [ExtractedItem] {
        struct Resp: Decodable { let items: [ExtractedItem]? }
        let data = try await post(config.server, "/api/notes", token: config.token, body: ["text": text, "source": "text"])
        return (try JSONDecoder().decode(Resp.self, from: data)).items ?? []
    }
}
