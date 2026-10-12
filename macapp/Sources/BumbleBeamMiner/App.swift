import AppKit
import Combine
import SwiftUI

@main
enum BumbleBeamMinerApp {
    static func main() {
        let app = NSApplication.shared
        if let i = CommandLine.arguments.firstIndex(of: "--snapshot"), i + 1 < CommandLine.arguments.count {
            if #available(macOS 13.0, *) { MainActor.assumeIsolated { Snapshot.run(into: CommandLine.arguments[i + 1]) } }
        }
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)   // menu bar only, no Dock icon
        app.run()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let settings = Settings()
    private lazy var miner = Miner(settings: settings)
    private lazy var pool = Pool(settings: settings)
    private let power = PowerSource()
    private let gpu = GPUPower()
    private var reporter: SpeedReporter?
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private var bag = Set<AnyCancellable>()
    private var signalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ note: Notification) {
        Miner.killLeftovers()
        // `kill`, logout or a terminal's Ctrl-C: stop the miner first, it would outlive the app
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { [weak self] in self?.miner.stopNow(); exit(0) }
            src.resume()
            signalSources.append(src)
        }
        NSApp.mainMenu = AppDelegate.editMenu()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let b = statusItem.button {
            b.target = self
            b.action = #selector(clicked(_:))
            b.sendAction(on: [.leftMouseUp, .rightMouseUp])
            b.imagePosition = .imageLeading
            b.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)
            b.toolTip = "BumbleBeam Miner"
        }
        popover.behavior = .transient
        popover.animates = false
        popover.appearance = NSAppearance(named: .darkAqua)
        let host = NSHostingController(rootView: PopoverView(settings: settings, miner: miner, pool: pool, power: power, gpu: gpu))
        if #available(macOS 13.0, *) { host.sizingOptions = [] }
        popover.contentSize = PopoverView.size
        popover.contentViewController = host

        reporter = SpeedReporter(settings: settings, miner: miner, gpu: gpu)
        miner.$pid.sink { [weak self] p in self?.gpu.pid = p }.store(in: &bag)
        // a new mining session starts at every Start
        miner.$startedAt.compactMap { $0 }.removeDuplicates()
            .sink { [weak self] _ in self?.pool.startSession() }
            .store(in: &bag)
        miner.objectWillChange.merge(with: settings.objectWillChange)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in DispatchQueue.main.async { self?.updateIcon() } }
            .store(in: &bag)
        // keep-awake follows the adapter even while the popover is closed
        power.$onAC.dropFirst().receive(on: DispatchQueue.main)
            .sink { [weak self] onAC in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if !onAC { self.settings.keepAwakeOnBattery = false }   // pulled: off until asked
                    self.miner.updateAwake()
                }
            }
            .store(in: &bag)
        updateIcon()

        if !settings.configured { DispatchQueue.main.async { self.showPopover() } }
        // `--start` (or "Start mining on launch") begins mining right away, e.g. from a login item
        if settings.configured && (CommandLine.arguments.contains("--start") || settings.startOnLaunch) { miner.start() }
    }

    func applicationWillTerminate(_ note: Notification) { miner.stopNow() }

    /// A menu bar app shows no menus, but text fields only get ⌘A, ⌘C, ⌘V, ⌘X and ⌘Z through the
    /// key equivalents of a main menu, so it has one that is never on screen.
    static func editMenu() -> NSMenu {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let app = NSMenu(); appItem.submenu = app
        app.addItem(withTitle: "Quit BumbleBeam Miner", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit"); editItem.submenu = edit
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        return main
    }

    @objc private func clicked(_ sender: NSStatusBarButton) {
        // ⌥-click starts or stops without opening the popover
        if NSEvent.modifierFlags.contains(.option), settings.configured {
            miner.running ? miner.stop() : miner.start()
            return
        }
        popover.isShown ? popover.performClose(nil) : showPopover()
    }

    private func showPopover() {
        guard let b = statusItem.button else { return }
        pool.refresh()
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: b.bounds, of: b, preferredEdge: .minY)
    }

    private func updateIcon() {
        guard let b = statusItem.button else { return }
        let badge: StatusIcon.Badge
        switch miner.state {
        case .mining, .starting: badge = .play
        case .noConnection: badge = .dot
        case .stopped: badge = .pause
        }
        b.image = StatusIcon.image(badge)
        gpu.run(miner.running && settings.device == .gpu)
        let showNumber = settings.showRate && miner.state == .mining && miner.rate > 0
        b.title = showNumber ? String(format: " %.1f", miner.rate) : ""
    }
}
