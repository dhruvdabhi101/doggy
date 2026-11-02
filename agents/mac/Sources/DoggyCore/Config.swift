import Foundation

public func log(_ msg: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    FileHandle.standardError.write("[\(ts)] \(msg)\n".data(using: .utf8)!)
}

public enum Paths {
    public static let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".doggy")
    public static let config = dir.appendingPathComponent("agent.json")
    public static let paused = dir.appendingPathComponent("paused")
}

public struct AgentConfig: Codable, Equatable {
    public static let defaultServer = "https://doggy.ruv.world"

    public var server: String
    public var token: String
    public var excludeApps: [String]?

    public init(server: String, token: String, excludeApps: [String]? = nil) {
        self.server = server
        self.token = token
        self.excludeApps = excludeApps
    }

    /// A config with an empty token (written by "Sign out") counts as signed out.
    public var isSignedIn: Bool { !token.isEmpty }

    public static func load() -> AgentConfig? {
        guard let data = try? Data(contentsOf: Paths.config) else { return nil }
        return try? JSONDecoder().decode(AgentConfig.self, from: data)
    }

    public func save() throws {
        try FileManager.default.createDirectory(at: Paths.dir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(self).write(to: Paths.config, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Paths.config.path)
    }
}

/// Default apps never captured. Matched case-insensitively against bundle id (exact) or app name (contains).
public let defaultExcludes: [String] = [
    "1Password", "com.1password.1password", "com.agilebits.onepassword7",
    "Bitwarden", "com.bitwarden.desktop",
    "Keychain Access", "com.apple.keychainaccess",
    "System Settings", "System Preferences", "com.apple.systempreferences", "com.apple.Settings",
    "loginwindow", "com.apple.loginwindow",
    "com.apple.SecurityAgent", "com.apple.Passwords",
]

public func isExcluded(name: String, bundleId: String?, extra: [String]) -> Bool {
    let n = name.lowercased()
    let b = (bundleId ?? "").lowercased()
    for raw in defaultExcludes + extra {
        let e = raw.lowercased()
        if e.isEmpty { continue }
        if e == b || e == n || (e.count > 3 && !e.contains(".") && n.contains(e)) { return true }
    }
    return false
}

public var isPaused: Bool { FileManager.default.fileExists(atPath: Paths.paused.path) }

/// Creates or removes ~/.doggy/paused (shared with the CLI).
public func setPaused(_ paused: Bool) {
    if paused {
        try? FileManager.default.createDirectory(at: Paths.dir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        FileManager.default.createFile(atPath: Paths.paused.path, contents: nil)
    } else {
        try? FileManager.default.removeItem(at: Paths.paused)
    }
}
