import AppKit
import ApplicationServices

public struct WindowSnapshot {
    public let app: String
    public let bundleId: String?
    public let window: String
    public let url: String?
    public let lines: [String]
}

public func checkAccessibility(prompt: Bool) -> Bool {
    let opts = ["AXTrustedCheckOptionPrompt": prompt] as CFDictionary
    return AXIsProcessTrustedWithOptions(opts)
}

private let textRoles: Set<String> = [
    "AXStaticText", "AXTextArea", "AXTextField", "AXHeading", "AXLink", "AXCell",
    "AXComboBox", "AXSearchField",
]

private func str(_ v: AnyObject?) -> String? {
    guard let v, CFGetTypeID(v) == CFStringGetTypeID() else { return nil }
    let s = v as! String
    return s.isEmpty ? nil : s
}

private func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

public final class AXCapture {
    let maxNodes = 3000
    let maxDepth = 40
    let timeBudget: TimeInterval = 0.4
    let maxValueChars = 20_000

    public init() {
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.5)
    }

    public func frontmost(exclude: [String]) -> WindowSnapshot? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let name = app.localizedName ?? app.bundleIdentifier ?? "Unknown"
        if app.processIdentifier == getpid() { return nil }
        if isExcluded(name: name, bundleId: app.bundleIdentifier, extra: exclude) { return nil }

        let appEl = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(appEl, 0.5)
        // Makes Electron/Chromium apps expose their accessibility tree. Errors ignored.
        _ = AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)

        guard let winObj = attr(appEl, kAXFocusedWindowAttribute as String),
              CFGetTypeID(winObj) == AXUIElementGetTypeID() else { return nil }
        let win = winObj as! AXUIElement
        AXUIElementSetMessagingTimeout(win, 0.5)
        let title = str(attr(win, kAXTitleAttribute as String)) ?? ""

        var lines: [String] = []
        var url: String?
        walk(win, lines: &lines, url: &url)
        return WindowSnapshot(app: name, bundleId: app.bundleIdentifier, window: title, url: url, lines: lines)
    }

    private func walk(_ root: AXUIElement, lines: inout [String], url: inout String?) {
        let deadline = Date().addingTimeInterval(timeBudget)
        var stack: [(AXUIElement, Int)] = [(root, 0)]
        var visited = 0
        let attrs = ["AXRole", "AXValue", "AXTitle", "AXDescription", "AXChildren"] as CFArray

        while let (el, depth) = stack.popLast() {
            visited += 1
            if visited > maxNodes || Date() > deadline { break }

            var valuesRef: CFArray?
            guard AXUIElementCopyMultipleAttributeValues(el, attrs, AXCopyMultipleAttributeOptions(rawValue: 0), &valuesRef) == .success,
                  let values = valuesRef as? [AnyObject], values.count == 5 else { continue }

            let role = str(values[0]) ?? ""
            if role == "AXSecureTextField" { continue }  // never read passwords, nor descend

            if role == "AXWebArea", url == nil, let u = attr(el, "AXURL") {
                if CFGetTypeID(u) == CFURLGetTypeID() { url = (u as! URL).absoluteString }
                else if let s = str(u) { url = s }
            }

            if textRoles.contains(role) {
                for v in [values[1], values[2], values[3]] {
                    if var s = str(v) {
                        if s.count > maxValueChars { s = String(s.prefix(maxValueChars)) }
                        lines.append(contentsOf: s.split(whereSeparator: \.isNewline).map(String.init))
                    }
                }
            }

            if depth < maxDepth, let kids = values[4] as? [AXUIElement] {
                // push reversed so we visit in document order
                for k in kids.reversed() { stack.append((k, depth + 1)) }
            }
        }
    }
}
