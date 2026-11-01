// swift-tools-version:5.9
// BumbleBeam Miner: a menu bar app that runs MXBM (GPU, Metal) or bumblebeam-miner (CPU) against
// pool.bumblebeam.org. build.sh turns the executable into an .app bundle and a .dmg.
import PackageDescription

let package = Package(
    name: "BumbleBeamMiner",
    platforms: [.macOS(.v12)],
    targets: [
        .executableTarget(
            name: "BumbleBeamMiner",
            path: "Sources/BumbleBeamMiner",
            linkerSettings: [.linkedFramework("IOKit")]
        ),
    ]
)
