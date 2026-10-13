// Draws the desktop app's icons on a Mac: the app icon from the pool's logo (as the Mac app's)
// and the tray icons (the hexagon with a play, pause or no-connection badge, in white for dark
// taskbars and black for light ones). The .ico is put together by tools/icons.sh.
// usage: swift icons.swift <favicon.svg> <out dir>
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let logo = NSImage(contentsOfFile: args[1]) else { exit(1) }
let out = URL(fileURLWithPath: args[2])
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func png(_ px: Int, _ draw: (CGFloat) -> Void) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    draw(CGFloat(px))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

func appIcon(_ s: CGFloat) {
    let inset = s * 40 / 1024
    let tile = NSRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let path = NSBezierPath(roundedRect: tile, xRadius: tile.width * 0.2, yRadius: tile.width * 0.2)
    NSGradient(colors: [NSColor(srgbRed: 0.04, green: 0.35, blue: 0.50, alpha: 1),
                        NSColor(srgbRed: 0.01, green: 0.11, blue: 0.21, alpha: 1)])!.draw(in: path, angle: -90)
    logo.draw(in: tile.insetBy(dx: tile.width * 0.12, dy: tile.width * 0.12))
}

enum Badge { case play, pause, dot }

// the Mac app's StatusIcon, in a 16-unit grid scaled to the image (y up here)
func trayIcon(_ s: CGFloat, _ badge: Badge, light: Bool) {
    let k = s / 16
    let t = NSAffineTransform()
    t.scale(by: k)
    t.concat()
    let fg = light ? NSColor.black : NSColor.white
    let amber = light ? NSColor(srgbRed: 0.79, green: 0.59, blue: 0, alpha: 1) : NSColor(srgbRed: 0.96, green: 0.81, blue: 0.29, alpha: 1)
    let hex = NSBezierPath()
    hex.move(to: NSPoint(x: 8, y: 16 - 1.6)); hex.line(to: NSPoint(x: 13.5, y: 16 - 4.8)); hex.line(to: NSPoint(x: 13.5, y: 16 - 11.2))
    hex.line(to: NSPoint(x: 8, y: 16 - 14.4)); hex.line(to: NSPoint(x: 2.5, y: 16 - 11.2)); hex.line(to: NSPoint(x: 2.5, y: 16 - 4.8)); hex.close()
    hex.lineWidth = 1.4
    hex.lineJoinStyle = .round
    fg.setStroke()
    hex.stroke()
    let c = NSPoint(x: 12.2, y: 16 - 4.6), r: CGFloat = 4.4
    NSGraphicsContext.current?.compositingOperation = .clear
    NSBezierPath(ovalIn: NSRect(x: c.x - r - 0.8, y: c.y - r - 0.8, width: 2 * r + 1.6, height: 2 * r + 1.6)).fill()
    NSGraphicsContext.current?.compositingOperation = .sourceOver
    amber.setFill()
    switch badge {
    case .dot:
        NSBezierPath(ovalIn: NSRect(x: c.x - 3.2, y: c.y - 3.2, width: 6.4, height: 6.4)).fill()
    case .play:
        let p = NSBezierPath()
        p.move(to: NSPoint(x: c.x - 2.6, y: c.y + 3.6)); p.line(to: NSPoint(x: c.x + 3.6, y: c.y)); p.line(to: NSPoint(x: c.x - 2.6, y: c.y - 3.6)); p.close()
        p.fill()
    case .pause:
        NSBezierPath(roundedRect: NSRect(x: c.x - 3.1, y: c.y - 3.5, width: 2.3, height: 7), xRadius: 0.6, yRadius: 0.6).fill()
        NSBezierPath(roundedRect: NSRect(x: c.x + 0.8, y: c.y - 3.5, width: 2.3, height: 7), xRadius: 0.6, yRadius: 0.6).fill()
    }
}

for (name, px) in [("32x32", 32), ("128x128", 128), ("128x128@2x", 256), ("icon", 512),
                   ("ico-16", 16), ("ico-24", 24), ("ico-32", 32), ("ico-48", 48), ("ico-64", 64), ("ico-256", 256)] {
    try! png(px, appIcon).write(to: out.appendingPathComponent("\(name).png"))
}
for (b, n) in [(Badge.play, "play"), (.pause, "pause"), (.dot, "dot")] {
    for light in [false, true] {
        try! png(64) { trayIcon($0, b, light: light) }.write(to: out.appendingPathComponent("tray-\(n)-\(light ? "light" : "dark").png"))
    }
}
