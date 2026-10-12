import AppKit
import SwiftUI

/// The pool site's look (pool/web/styles.css): dark Beam blue, the #00f6d2 accent, mono type for data.
enum Theme {
    static let accent = Color(hex: 0x00f6d2)
    static let yellow = Color(hex: 0xf4ce4a)
    static let red = Color(hex: 0xf25f5b)
    static let darkBlue = Color(hex: 0x032e49)
    static let field = Color(hex: 0x193b55)
    static let background = LinearGradient(colors: [Color(hex: 0x031d35), Color(hex: 0x043a5b), Color(hex: 0x074a6c)],
                                           startPoint: .top, endPoint: .bottom)
    static let muted = Color.white.opacity(0.55)
    static let border = Color.white.opacity(0.09)
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xff) / 255, green: Double((hex >> 8) & 0xff) / 255,
                  blue: Double(hex & 0xff) / 255, opacity: alpha)
    }
}

extension NSColor {
    convenience init(hex: UInt32) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
                  blue: CGFloat(hex & 0xff) / 255, alpha: 1)
    }
}

/// The BumbleBeam logo (pool/web/favicon.svg), drawn in its 32x32 coordinates and animated like the
/// pool site's header (pool/web/styles.css): the bee bobs, its wings flutter, the light trail
/// streams and the eye blinks. Still when the system asks to reduce motion.
struct Logo: View {
    var size: CGFloat = 30
    var body: some View {
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            canvas(t: nil)
        } else {
            TimelineView(.animation) { tl in canvas(t: tl.date.timeIntervalSinceReferenceDate) }
        }
    }

    /// 0 at the ends of a period, 1 in the middle, eased like CSS ease-in-out
    private static func wave(_ t: Double, _ period: Double) -> Double {
        (1 - cos(2 * .pi * t / period)) / 2
    }

    private func canvas(t: Double?) -> some View {
        Canvas { ctx, sz in
            let k = size / 32
            ctx.scaleBy(x: k, y: k)
            var hex = Path()
            hex.move(to: CGPoint(x: 16, y: 2)); hex.addLine(to: CGPoint(x: 28, y: 9)); hex.addLine(to: CGPoint(x: 28, y: 23))
            hex.addLine(to: CGPoint(x: 16, y: 30)); hex.addLine(to: CGPoint(x: 4, y: 23)); hex.addLine(to: CGPoint(x: 4, y: 9)); hex.closeSubpath()
            let h = ctx
            h.fill(hex, with: .linearGradient(Gradient(colors: [Color(hex: 0x0b76ff), Color(hex: 0x39fff2)]),
                                              startPoint: CGPoint(x: 4, y: 30), endPoint: CGPoint(x: 28, y: 2)))

            // logo-bob, 3 s: the whole bee rises 0.9 and settles
            var bee = ctx
            bee.translateBy(x: 0, y: -0.9 * (t.map { Logo.wave($0, 3) } ?? 0))

            // logo-trail, 1.5 s: each streak brightens and slides; the second runs 0.5 s ahead
            for (i, line) in [(CGPoint(x: 4.5, y: 20), CGPoint(x: 8, y: 20)), (CGPoint(x: 3.5, y: 23.5), CGPoint(x: 6, y: 23.5))].enumerated() {
                let w = t.map { Logo.wave($0 + (i == 1 ? 0.5 : 0), 1.5) }
                var tr = bee
                tr.translateBy(x: w.map { 1.2 - 2.2 * $0 } ?? 0, y: 0)
                var p = Path(); p.move(to: line.0); p.addLine(to: line.1)
                tr.stroke(p, with: .color(.white.opacity(w.map { 0.25 + 0.6 * $0 } ?? 0.6)),
                          style: StrokeStyle(lineWidth: 1.3, lineCap: .round))
            }

            // logo-flutter, 0.22 s alternate: each wing swings -9..9 degrees about its base;
            // the right wing is half a beat behind
            for (i, (cx, angle)) in [(14.5, -24.0), (20.0, 24.0)].enumerated() {
                let u = t.map { Logo.wave($0 + (i == 1 ? 0.11 : 0), 0.44) } ?? 0.5
                var w = bee
                w.translateBy(x: cx, y: 10.8)
                w.rotate(by: .degrees(angle))
                w.translateBy(x: 0, y: 2.1)                 // pivot at the wing's base
                w.rotate(by: .degrees(-9 + 18 * u))
                w.scaleBy(x: 1, y: 0.92 + 0.13 * u)
                w.translateBy(x: 0, y: -2.1)
                let e = Path(ellipseIn: CGRect(x: -3.6, y: -2.1, width: 7.2, height: 4.2))
                w.fill(e, with: .color(.white.opacity(0.9)))
                w.stroke(e, with: .color(Color(hex: 0x042548)), lineWidth: 0.6)
            }

            let body = Path(roundedRect: CGRect(x: 9.5, y: 13.5, width: 15, height: 9), cornerRadius: 4.5)
            bee.fill(body, with: .color(Color(hex: 0x042548)))
            var stripes = bee
            stripes.clip(to: body)
            stripes.fill(Path(CGRect(x: 13.3, y: 13, width: 3, height: 10)), with: .color(Theme.yellow))
            stripes.fill(Path(CGRect(x: 18.6, y: 13, width: 3, height: 10)), with: .color(Theme.yellow))
            // logo-blink, 4 s: the eye shuts for a moment near the end of the cycle
            let phase = t.map { $0.truncatingRemainder(dividingBy: 4) / 4 } ?? 0
            let open = !(phase >= 0.95 && phase < 0.98)
            if open {
                bee.fill(Path(ellipseIn: CGRect(x: 21.65, y: 16.05, width: 1.9, height: 1.9)), with: .color(Color(hex: 0x39fff2)))
            }
        }
        .frame(width: size, height: size)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The menu bar icon: an outline hexagon with a badge in the corner: play while mining, pause when
/// stopped, a dot when the pool cannot be reached. The badge is amber; the outline follows the menu bar.
enum StatusIcon {
    enum Badge { case play, pause, dot }

    static func image(_ badge: Badge) -> NSImage {
        let img = NSImage(size: NSSize(width: 19, height: 16), flipped: true) { _ in
            let dark = NSAppearance.currentDrawing().bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let fg = dark ? NSColor.white : NSColor.black
            let amber = dark ? NSColor(hex: 0xf4ce4a) : NSColor(hex: 0xc99700)
            let hex = NSBezierPath()
            hex.move(to: NSPoint(x: 8, y: 1.6)); hex.line(to: NSPoint(x: 13.5, y: 4.8)); hex.line(to: NSPoint(x: 13.5, y: 11.2))
            hex.line(to: NSPoint(x: 8, y: 14.4)); hex.line(to: NSPoint(x: 2.5, y: 11.2)); hex.line(to: NSPoint(x: 2.5, y: 4.8)); hex.close()
            hex.lineWidth = 1.3
            hex.lineJoinStyle = .round
            fg.setStroke()
            hex.stroke()
            // cut a hole for the badge, then draw it
            let c = NSPoint(x: 14, y: 4.5), r: CGFloat = 4.6
            NSGraphicsContext.current?.compositingOperation = .clear
            NSBezierPath(ovalIn: NSRect(x: c.x - r - 0.8, y: c.y - r - 0.8, width: 2 * r + 1.6, height: 2 * r + 1.6)).fill()
            NSGraphicsContext.current?.compositingOperation = .sourceOver
            amber.setFill()
            switch badge {
            case .dot:
                NSBezierPath(ovalIn: NSRect(x: c.x - 3.2, y: c.y - 3.2, width: 6.4, height: 6.4)).fill()
            case .play:
                let t = NSBezierPath()
                t.move(to: NSPoint(x: c.x - 2.6, y: c.y - 3.6)); t.line(to: NSPoint(x: c.x + 3.6, y: c.y)); t.line(to: NSPoint(x: c.x - 2.6, y: c.y + 3.6)); t.close()
                t.fill()
            case .pause:
                NSBezierPath(roundedRect: NSRect(x: c.x - 3.1, y: c.y - 3.5, width: 2.3, height: 7), xRadius: 0.6, yRadius: 0.6).fill()
                NSBezierPath(roundedRect: NSRect(x: c.x + 0.8, y: c.y - 3.5, width: 2.3, height: 7), xRadius: 0.6, yRadius: 0.6).fill()
            }
            return true
        }
        img.isTemplate = false
        return img
    }
}
