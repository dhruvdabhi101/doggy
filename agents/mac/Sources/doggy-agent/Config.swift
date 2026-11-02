import Foundation

func log(_ msg: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    FileHandle.standardError.write("[\(ts)] \(msg)\n".data(using: .utf8)!)
}

enum Paths {
    static let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".doggy")
    static let config = dir.appendingPathComponent("agent.json")
    static let paused = dir.appendingPathComponent("paused")
}

struct AgentConfig: Codable {
    var server: String
    var token: String
    var excludeApps: [String]?

    static func load() -> AgentConfig? {
        guard let data = try? Data(contentsOf: Paths.config) else { return nil }
        return try? JSONDecoder().decode(AgentConfig.self, from: data)
    }

    func save() throws {
        try FileManager.default.createDirectory(at: Paths.dir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(self).write(to: Paths.config, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Paths.config.path)
    }
}

/// Default apps never captured. Matched case-insensitively against bundle id (exact) or app name (contains).
let defaultExcludes: [String] = [
    "1Password", "com.1password.1password", "com.agilebits.onepassword7",
    "Bitwarden", "com.bitwarden.desktop",
    "Keychain Access", "com.apple.keychainaccess",
    "System Settings", "System Preferences", "com.apple.systempreferences", "com.apple.Settings",
    "loginwindow", "com.apple.loginwindow",
    "com.apple.SecurityAgent", "com.apple.Passwords",
]

func isExcluded(name: String, bundleId: String?, extra: [String]) -> Bool {
    let n = name.lowercased()
    let b = (bundleId ?? "").lowercased()
    for raw in defaultExcludes + extra {
        let e = raw.lowercased()
        if e.isEmpty { continue }
        if e == b || e == n || (e.count > 3 && !e.contains(".") && n.contains(e)) { return true }
    }
    return false
}

var isPaused: Bool { FileManager.default.fileExists(atPath: Paths.paused.path) }
