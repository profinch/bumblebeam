import AppKit
import SwiftUI

/// `--snapshot <dir>`: renders the popover screens and the menu bar icons to PNGs and exits,
/// to check the look without opening the menu bar. AppKit-backed controls (slider, switch,
/// text field, picker) render as placeholders here.
@available(macOS 13.0, *)
enum Snapshot {
    @MainActor static func run(into dir: String) {
        let out = URL(fileURLWithPath: dir)
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let settings = Settings(), miner = Miner(settings: settings), pool = Pool(settings: settings)
        let power = PowerSource(), gpu = GPUPower()
        let views: [(String, AnyView)] = [
            ("main", AnyView(MainView(settings: settings, miner: miner, pool: pool, power: power, gpu: gpu) {}.frame(width: PopoverView.size.width, height: PopoverView.size.height, alignment: .top).background(Theme.background).foregroundColor(.white).environment(\.colorScheme, .dark))),
            ("settings", AnyView(SetupView(settings: settings, miner: miner, pool: pool, firstRun: false) {}.frame(width: PopoverView.size.width, height: PopoverView.size.height, alignment: .top).background(Theme.background).foregroundColor(.white).environment(\.colorScheme, .dark))),
            ("setup", AnyView(SetupView(settings: settings, miner: miner, pool: pool, firstRun: true) {}.frame(width: PopoverView.size.width, height: PopoverView.size.height, alignment: .top).background(Theme.background).foregroundColor(.white).environment(\.colorScheme, .dark))),
        ]
        // give the pool a moment to answer
        RunLoop.main.run(until: Date().addingTimeInterval(3))
        // <name>-appkit.png: the same screens drawn by AppKit in an offscreen window, so the
        // AppKit-backed controls show too
        for (name, v) in views {
            let host = NSHostingView(rootView: v)
            host.frame = NSRect(origin: .zero, size: PopoverView.size)
            let w = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            w.appearance = NSAppearance(named: .darkAqua)
            w.contentView = host
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.5))
            if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                host.cacheDisplay(in: host.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: out.appendingPathComponent("\(name)-appkit.png"))
            }
        }
        for (name, v) in views {
            let r = ImageRenderer(content: v)
            r.scale = 2
            if let img = r.nsImage, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
               let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: out.appendingPathComponent("\(name).png"))
            }
        }
        for (name, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
            let strip = NSImage(size: NSSize(width: 90, height: 24))
            strip.lockFocus()
            NSAppearance(named: appearance)!.performAsCurrentDrawingAppearance {
                (appearance == .darkAqua ? NSColor(white: 0.16, alpha: 1) : NSColor(white: 0.93, alpha: 1)).setFill()
                NSRect(x: 0, y: 0, width: 90, height: 24).fill()
                for (i, b) in [StatusIcon.Badge.play, .pause, .dot].enumerated() {
                    StatusIcon.image(b).draw(in: NSRect(x: 8 + i * 28, y: 4, width: 19, height: 16))
                }
            }
            strip.unlockFocus()
            if let tiff = strip.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
               let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: out.appendingPathComponent("icons-\(name).png"))
            }
        }
        exit(0)
    }
}
