// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "doggy-agent",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "DoggyCore", targets: ["DoggyCore"]),
        .executable(name: "doggy-agent", targets: ["doggy-agent"]),
        .executable(name: "DoggyApp", targets: ["DoggyApp"]),
    ],
    targets: [
        .target(
            name: "DoggyCore",
            path: "Sources/DoggyCore",
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("ApplicationServices")]
        ),
        .executableTarget(
            name: "doggy-agent",
            dependencies: ["DoggyCore"],
            path: "Sources/doggy-agent",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "DoggyApp",
            dependencies: ["DoggyCore"],
            path: "Sources/DoggyApp",
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [.linkedFramework("SwiftUI"), .linkedFramework("ServiceManagement")]
        ),
    ]
)
