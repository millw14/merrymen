// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MerrymenPolicy",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "MerrymenPolicy", targets: ["MerrymenPolicy"])],
    targets: [
        .target(name: "MerrymenPolicy"),
        .testTarget(name: "MerrymenPolicyTests", dependencies: ["MerrymenPolicy"])
    ]
)

