import AppKit
import SwiftUI

/// The power slider: an NSSlider with tick marks every 10 and the numbers centred under them.
struct TickSlider: NSViewRepresentable {
    @Binding var value: Double
    /// called when the knob is let go
    let commit: () -> Void

    func makeNSView(context: Context) -> TickSliderView {
        let v = TickSliderView()
        v.slider.target = context.coordinator
        v.slider.action = #selector(Coordinator.moved(_:))
        return v
    }

    func updateNSView(_ v: TickSliderView, context: Context) {
        context.coordinator.parent = self
        if v.slider.doubleValue != value { v.slider.doubleValue = value }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject {
        var parent: TickSlider
        init(_ p: TickSlider) { parent = p }
        @objc func moved(_ s: NSSlider) {
            let v = (s.doubleValue / 10).rounded() * 10
            if v != parent.value { parent.value = v }
            let t = NSApp.currentEvent?.type
            if t != .leftMouseDragged && t != .leftMouseDown { parent.commit() }   // mouse up, or a key
        }
    }
}

final class TickSliderView: NSView {
    let slider = NSSlider(value: 80, minValue: 10, maxValue: 100, target: nil, action: nil)
    private var labels: [NSTextField] = []

    override var isFlipped: Bool { true }

    init() {
        super.init(frame: .zero)
        slider.numberOfTickMarks = 10
        slider.allowsTickMarkValuesOnly = true
        slider.tickMarkPosition = .below
        slider.isContinuous = true
        slider.trackFillColor = NSColor(hex: 0x00f6d2)
        slider.setAccessibilityLabel("Power")
        addSubview(slider)
        for i in 0..<10 {
            let l = NSTextField(labelWithString: "\((i + 1) * 10)")
            l.font = .monospacedSystemFont(ofSize: 9.5, weight: .regular)
            l.textColor = NSColor.white.withAlphaComponent(0.45)
            l.alignment = .center
            l.setAccessibilityElement(false)
            labels.append(l)
            addSubview(l)
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: 40) }

    override func layout() {
        super.layout()
        labels.forEach { $0.sizeToFit() }
        // The slider is narrower than the row by half the widest number on each side, so the
        // numbers under the end marks (10, 100) stay inside the row.
        let inset = ((labels.map { $0.frame.width }.max() ?? 0) / 2).rounded(.up)
        let h = slider.fittingSize.height
        slider.frame = NSRect(x: inset, y: 0, width: max(bounds.width - 2 * inset, 0), height: h)
        slider.layoutSubtreeIfNeeded()
        // NSSlider draws its marks half a knob in from each end of the track, while
        // rectOfTickMark reports the bare track ends, so the marks are placed from the knob.
        let knob = slider.knobThickness
        for (i, l) in labels.enumerated() {
            let x = slider.frame.minX + knob / 2 + (slider.frame.width - knob) * CGFloat(i) / CGFloat(labels.count - 1)
            l.frame = NSRect(x: (x - l.frame.width / 2).rounded(), y: h + 1, width: l.frame.width, height: l.frame.height)
        }
    }
}
