// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TradeOrderSystemNative",
    platforms: [.macOS(.v12)],
    products: [
        .executable(name: "TradeOrderSystemNative", targets: ["TradeOrderSystemNative"]),
        .executable(name: "TradeOrderSystemCoreTests", targets: ["TradeOrderSystemCoreTests"])
    ],
    targets: [
        .target(name: "TradeOrderSystemCore"),
        .executableTarget(
            name: "TradeOrderSystemNative",
            dependencies: ["TradeOrderSystemCore"]
        ),
        .executableTarget(
            name: "TradeOrderSystemCoreTests",
            dependencies: ["TradeOrderSystemCore"]
        )
    ]
)
