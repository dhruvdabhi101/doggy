// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "doggy-agent",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "doggy-agent",
            path: "Sources/doggy-agent",
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("ApplicationServices")]
        )
    ]
)
