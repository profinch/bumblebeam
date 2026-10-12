import AppKit
import SwiftUI

/// What the menu bar popover shows: first-run setup until there is an address, then the miner.
struct PopoverView: View {
    @ObservedObject var settings: Settings
    @ObservedObject var miner: Miner
    @ObservedObject var pool: Pool
    @ObservedObject var power: PowerSource
    @ObservedObject var gpu: GPUPower
    @State private var editing = false

    /// One size for every screen and mode, so the popover never jumps.
    static let size = CGSize(width: 360, height: 664)

    var body: some View {
        Group {
            if !settings.configured || editing {
                SetupView(settings: settings, miner: miner, pool: pool, firstRun: !settings.configured) { editing = false }
            } else {
                MainView(settings: settings, miner: miner, pool: pool, power: power, gpu: gpu) { editing = true }
            }
        }
        .frame(width: PopoverView.size.width, height: PopoverView.size.height, alignment: .top)
        .background(Theme.background)
        .foregroundColor(.white)
        .environment(\.colorScheme, .dark)
    }
}

// MARK: - pieces

struct Label10: View {
    let text: String
    init(_ t: String) { text = t }
    var body: some View {
        Text(text.uppercased()).font(.system(size: 10, weight: .semibold)).tracking(0.8).foregroundColor(Theme.muted)
    }
}

struct Tile: View {
    let label: String
    let value: String
    var unit = "BEAM"
    var color: Color = .white
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Label10(label)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(value).font(Theme.mono(15, .semibold)).foregroundColor(color)
                Text(unit).font(Theme.mono(11)).foregroundColor(.white.opacity(0.45))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 11).padding(.vertical, 9)
        .background(Color.white.opacity(0.04))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.07)))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

/// A labelled switch on the right, as in the settings screen.
struct SettingSwitch: View {
    let title: String
    var note: String? = nil
    @Binding var isOn: Bool
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.system(size: 12))
                if let note { Text(note).font(.system(size: 10)).foregroundColor(Theme.muted) }
            }
            Spacer()
            Toggle(title, isOn: $isOn).labelsHidden().toggleStyle(.switch).tint(Theme.accent)
        }
    }
}

struct SharesTile: View {
    let ok: Int
    let bad: Int
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Label10("Shares")
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("\(ok)").font(Theme.mono(15, .semibold))
                Text("ok").font(Theme.mono(11)).foregroundColor(.white.opacity(0.45))
                Text("\(bad)").font(Theme.mono(15, .semibold)).padding(.leading, 8)
                Text("bad").font(Theme.mono(11)).foregroundColor(.white.opacity(0.45))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 11).padding(.vertical, 9)
        .background(Color.white.opacity(0.04))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.07)))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

/// Blocks found: by this Mac since Start, and by the whole address. A block lights the hexagon.
struct BlocksTile: View {
    let session: Int
    let total: Int?
    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: "hexagon.fill")
                .font(.system(size: 13))
                .foregroundColor(session > 0 ? Theme.yellow : .white.opacity(0.25))
                .accessibilityHidden(true)
            Label10("Blocks found")
            Spacer(minLength: 4)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("\(session)").font(Theme.mono(15, .semibold))
                    .foregroundColor(session > 0 ? Theme.yellow : .white)
                Text("this session").font(Theme.mono(11)).foregroundColor(.white.opacity(0.45))
                Text("\(total.map(String.init) ?? "—")").font(Theme.mono(15, .semibold)).padding(.leading, 10)
                Text("total").font(Theme.mono(11)).foregroundColor(.white.opacity(0.45))
            }
        }
        .padding(.horizontal, 11).padding(.vertical, 8)
        .background(Color.white.opacity(0.04))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.07)))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .help("This session: blocks this Mac's worker found since Start. Total: every block your address found on the pool")
    }
}

struct Sparkline: View {
    let values: [Double]
    var body: some View {
        GeometryReader { g in
            let maxV = max(values.max() ?? 1, 0.1) * 1.15
            let pts = values.enumerated().map { i, v in
                CGPoint(x: values.count < 2 ? 0 : g.size.width * CGFloat(i) / CGFloat(values.count - 1),
                        y: g.size.height - g.size.height * CGFloat(v / maxV))
            }
            if pts.count > 1 {
                ZStack {
                    Path { p in
                        p.move(to: CGPoint(x: pts[0].x, y: g.size.height))
                        pts.forEach { p.addLine(to: $0) }
                        p.addLine(to: CGPoint(x: pts.last!.x, y: g.size.height))
                        p.closeSubpath()
                    }
                    .fill(LinearGradient(colors: [Theme.accent.opacity(0.35), Theme.accent.opacity(0)], startPoint: .top, endPoint: .bottom))
                    Path { p in p.addLines(pts) }
                        .stroke(Theme.accent, style: StrokeStyle(lineWidth: 1.6, lineJoin: .round))
                }
            } else {
                Path { p in p.move(to: CGPoint(x: 0, y: g.size.height - 1)); p.addLine(to: CGPoint(x: g.size.width, y: g.size.height - 1)) }
                    .stroke(Color.white.opacity(0.15), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
        }
        .frame(height: 34)
        .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.12),
                                     .init(color: .black, location: 0.88), .init(color: .clear, location: 1)],
                             startPoint: .leading, endPoint: .trailing))
        .accessibilityHidden(true)
    }
}

/// A GPU/CPU choice: the whole card selects; the miner's name on the right.
struct DeviceCard: View {
    let title: String
    let detail: String
    let maker: String
    let on: Bool
    let action: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.system(size: 13, weight: .semibold))
                Spacer(minLength: 4)
                Text(maker)
                    .font(Theme.mono(10))
                    .foregroundColor(on ? Theme.accent : Theme.muted)
            }
            Text(detail).font(Theme.mono(10)).foregroundColor(Theme.muted)
        }
        .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
        .padding(.horizontal, 11).padding(.vertical, 4)
        .background(on ? Theme.accent.opacity(0.12) : Color.clear)
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(on ? Theme.accent.opacity(0.55) : Color.clear))
        .clipShape(RoundedRectangle(cornerRadius: 9))
        .contentShape(Rectangle())
        .onTapGesture(perform: action)
        .foregroundColor(on ? .white : .white.opacity(0.75))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction(.default, action)
    }
}

extension View {
    /// No rectangle drawn around a focused link or card (the pool site has none either).
    @ViewBuilder func noFocusRing() -> some View {
        if #available(macOS 14.0, *) { self.focusEffectDisabled() } else { self }
    }
}

/// A link: opens `url` in the browser. Plain, no focus ring, the ordinary arrow cursor.
struct LinkButton<Label: View>: View {
    let url: URL
    @ViewBuilder let label: () -> Label
    var body: some View {
        Button { NSWorkspace.shared.open(url) } label: { label() }
            .buttonStyle(.plain)
            .noFocusRing()
            .accessibilityAddTraits(.isLink)
            .help(url.absoluteString)
    }
}

enum AppInfo {
    static let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
}

enum Links {
    static let mxbm = URL(string: "https://git.maxnflaxl.dev/maxnflaxl/MXBM")!
}

func fmt(_ v: Double?, _ digits: Int = 2) -> String {
    guard let v else { return "—" }
    return String(format: "%.\(digits)f", v)
}

// MARK: - main

struct MainView: View {
    @ObservedObject var settings: Settings
    @ObservedObject var miner: Miner
    @ObservedObject var pool: Pool
    @ObservedObject var power: PowerSource
    @ObservedObject var gpu: GPUPower
    let openSettings: () -> Void
    @State private var level: Double = 80

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            rateCard
            VStack(alignment: .leading, spacing: 6) {
                Label10("Mine with")
                HStack(spacing: 6) {
                    DeviceCard(title: "GPU", detail: "Metal", maker: "MXBM",
                               on: settings.device == .gpu) { pick(.gpu) }
                    DeviceCard(title: "CPU", detail: "\(Miner.cpuThreads) threads", maker: "BumbleBeam",
                               on: settings.device == .cpu) { pick(.cpu) }
                }
                .padding(3)
                .background(Color.black.opacity(0.25))
                .overlay(RoundedRectangle(cornerRadius: 11).stroke(Theme.border))
                .clipShape(RoundedRectangle(cornerRadius: 11))
            }
            powerSlider
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 6) {
                Tile(label: "Unpaid", value: fmt(pool.balance))
                Tile(label: "Immature", value: fmt(pool.immature), color: Theme.yellow)
                SharesTile(ok: miner.accepted, bad: miner.rejected)
                Tile(label: "Est. per day", value: "≈ " + fmt(pool.perDay(rate: expectedRate), 1))
            }
            BlocksTile(session: pool.blocksSession, total: pool.blocksTotal)
            // On the adapter the switch is the user's remembered choice. Pulling the adapter turns
            // it off; on battery the user can turn it on again; plugging back in restores the choice.
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Keep Mac awake while mining").font(.system(size: 12))
                    Text("better on power adapter").font(.system(size: 10)).foregroundColor(Theme.muted)
                }
                Spacer()
                Toggle("Keep Mac awake while mining", isOn: Binding(
                    get: { power.onAC ? settings.keepAwake : settings.keepAwakeOnBattery },
                    set: { if power.onAC { settings.keepAwake = $0 } else { settings.keepAwakeOnBattery = $0 } }))
                    .labelsHidden().toggleStyle(.switch).tint(Theme.accent)
            }
            .onChange(of: settings.keepAwake) { _ in miner.updateAwake() }
            .onChange(of: settings.keepAwakeOnBattery) { _ in miner.updateAwake() }
            .onChange(of: power.onAC) { _ in miner.updateAwake() }

            Spacer(minLength: 0)

            Button(action: { miner.running ? miner.stop() : miner.start() }) {
                Text(miner.running ? "Stop mining" : "Start mining")
                    .font(.system(size: 14, weight: .bold))
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .foregroundColor(miner.running ? Theme.red : Theme.darkBlue)
                    .background(miner.running ? Color.clear : Theme.accent)
                    .overlay(RoundedRectangle(cornerRadius: 11).stroke(miner.running ? Theme.red.opacity(0.6) : Theme.accent))
                    .clipShape(RoundedRectangle(cornerRadius: 11))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.defaultAction)

            footer
        }
        .padding(14)
        .onAppear { level = Double(settings.power); pool.refresh() }
    }

    private var expectedRate: Double {
        // the miner's own figure while it runs, else what the pool last saw; nothing before either
        miner.running && miner.rate > 0 ? miner.rate : (pool.workerRate ?? 0)
    }

    private func pick(_ d: Device) {
        guard d != settings.device else { return }
        settings.device = d
        miner.restartIfRunning()
    }

    private var header: some View {
        HStack(spacing: 9) {
            // the logo and the name together open this miner's page on the pool site
            LinkButton(url: poolPage) {
                HStack(spacing: 9) {
                    Logo(size: 30)
                    (Text("Bumble").bold() + Text("Beam").bold().foregroundColor(Color(hex: 0x39fff2)) + Text(" Miner").foregroundColor(.white.opacity(0.5)))
                        .font(.system(size: 15))
                }
                .foregroundColor(.white)
                .contentShape(Rectangle())
            }

            Spacer()
            statusPill
        }
    }

    private var statusPill: some View {
        let (text, color): (String, Color) = {
            switch miner.state {
            case .stopped: return ("STOPPED", .white.opacity(0.6))
            case .starting: return ("STARTING", Theme.accent)
            case .mining: return ("MINING", Theme.accent)
            case .noConnection: return ("NO CONNECTION", Theme.yellow)
            }
        }()
        let lit = miner.state != .stopped
        return HStack(spacing: 6) {
            Circle().fill(lit ? color : Color.white.opacity(0.4)).frame(width: 7, height: 7)
                .shadow(color: lit ? color : .clear, radius: 3)
            Text(text).font(.system(size: 10, weight: .bold)).tracking(0.6)
        }
        .foregroundColor(color)
        .padding(.horizontal, 9).padding(.vertical, 4)
        .background(lit ? color.opacity(0.1) : Color.clear)
        .overlay(Capsule().stroke(lit ? color.opacity(0.45) : Color.white.opacity(0.18)))
        .clipShape(Capsule())
    }

    private var rateCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label10("Hashrate")
                Spacer(minLength: 8)
                cardNote
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(String(format: "%.1f", miner.running ? miner.rate : 0))
                    .font(Theme.mono(40, .semibold))
                    .foregroundColor(miner.running ? .white : .white.opacity(0.4))
                Text("sol/s").font(Theme.mono(14)).foregroundColor(.white.opacity(0.6))
                Spacer()
                // the pool averages this worker's shares over 10 minutes: it climbs for 10 minutes
                // after a start and runs a little under the miner's own figure (MXBM's dev fee, luck)
                (Text("pool shows ").foregroundColor(Theme.muted)
                 + Text(pool.workerRate.map { String(format: "%.1f", $0) } ?? "—").foregroundColor(.white))
                    .font(Theme.mono(11))
                    .help("The pool's average over the last 10 minutes")
            }
            Sparkline(values: miner.history)
        }
        .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 8)
        .background(Color.black.opacity(0.28))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.08)))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    /// The rate card's corner: why the miner is not connected, or that the pool site does not
    /// answer, else the chip it mines on. One line, so nothing below moves.
    @ViewBuilder private var cardNote: some View {
        if case .noConnection(let why) = miner.state {
            Text(why).font(.system(size: 11)).foregroundColor(Theme.yellow).lineLimit(1).truncationMode(.tail).help(why)
        } else if pool.unreachable {
            Text("pool site unreachable, figures may be old").font(.system(size: 11)).foregroundColor(Theme.yellow).lineLimit(1)
        } else {
            Text("\(Machine.chip) \(settings.device == .gpu ? "GPU" : "CPU")").font(.system(size: 11)).foregroundColor(Theme.muted).lineLimit(1)
        }
    }

    private var powerSlider: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label10("Power")
                Spacer()
                Text(powerNote).font(Theme.mono(10.5)).foregroundColor(Theme.muted).lineLimit(1)
                Text("\(Int(level))%").font(Theme.mono(13, .semibold)).foregroundColor(Theme.accent)
                    .frame(width: 40, alignment: .trailing)
            }
            TickSlider(value: $level) {
                if Int(level) != settings.power {
                    settings.power = Int(level)
                    miner.powerChanged()
                }
            }
            .frame(height: 40)
        }
    }

    /// Short and the same height in both modes: threads for the CPU, the GPU's draw while it mines.
    private var powerNote: String {
        if settings.device == .cpu {
            return "\(Miner.threads(forPower: Int(level))) of \(Miner.cpuThreads) threads"
        }
        if let w = gpu.watts, miner.running { return String(format: "%.1f W", w) }   // the miner's own share
        return ""
    }

    private var footer: some View {
        HStack(spacing: 4) {
            Text(shortAddress + "." + settings.cleanWorker)
                .font(Theme.mono(10)).foregroundColor(.white.opacity(0.5))
                .lineLimit(1)
            Spacer(minLength: 4)
            Button("Settings", action: openSettings).buttonStyle(.plain).font(.system(size: 12)).foregroundColor(.white.opacity(0.7))
                .padding(.trailing, 14)
            Button("Quit") { NSApp.terminate(nil) }.buttonStyle(.plain).font(.system(size: 12)).foregroundColor(.white.opacity(0.7))
        }
        .padding(.top, 8)
        .overlay(Rectangle().fill(Color.white.opacity(0.08)).frame(height: 1), alignment: .top)
    }

    private var shortAddress: String {
        let a = settings.address
        return a.count > 12 ? "\(a.prefix(5))…\(a.suffix(5))" : a
    }

    private var poolPage: URL {
        URL(string: "https://pool.bumblebeam.org/miners/\(settings.address)") ?? Pool.base
    }
}

// MARK: - setup

struct SetupView: View {
    @ObservedObject var settings: Settings
    @ObservedObject var miner: Miner
    @ObservedObject var pool: Pool
    let firstRun: Bool
    let done: () -> Void

    @State private var address = ""
    @State private var worker = ""
    @State private var mode: PayoutMode = .pplns
    @State private var showRate = true
    @State private var atLogin = false
    @State private var shareSpeed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(spacing: 8) {
                Logo(size: 52)
                Text(firstRun ? "Mine Beam on this Mac" : "Settings").font(.system(size: 17, weight: .bold))
                VStack(spacing: 2) {
                    Text("Pays to your Beam wallet through").foregroundColor(.white.opacity(0.65))
                    LinkButton(url: Pool.base) { Text("pool.bumblebeam.org").foregroundColor(Theme.accent) }
                }
                .font(.system(size: 12))
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 4)

            VStack(alignment: .leading, spacing: 6) {
                Label10("Beam address")
                TextField("Paste a public offline address", text: $address)
                    .textFieldStyle(.plain).font(Theme.mono(12))
                    .padding(.horizontal, 10).frame(height: 36)
                    .background(Theme.field)
                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(addressOK ? Theme.accent.opacity(0.5) : Color.white.opacity(0.12)))
                    .clipShape(RoundedRectangle(cornerRadius: 9))
                Text(addressNote.0).font(.system(size: 11)).foregroundColor(addressNote.1)
            }

            VStack(alignment: .leading, spacing: 6) {
                Label10("Worker name")
                TextField("bumblebeam", text: $worker)
                    .textFieldStyle(.plain).font(Theme.mono(12))
                    .padding(.horizontal, 10).frame(height: 36)
                    .background(Theme.field)
                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.white.opacity(0.12)))
                    .clipShape(RoundedRectangle(cornerRadius: 9))
            }

            HStack {
                Label10("Pool mode")
                Spacer()
                Picker("Pool mode", selection: $mode) {
                    Text("PPLNS").tag(PayoutMode.pplns)
                    Text("SOLO").tag(PayoutMode.solo)
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 150)
            }
            if !firstRun {
                SettingSwitch(title: "Show sol/s in the menu bar", isOn: $showRate)
                if LoginItem.available {
                    SettingSwitch(title: "Start mining at login", isOn: $atLogin)
                }
                SettingSwitch(title: "Share average speed",
                              note: "Mac model and speed, no address",
                              isOn: $shareSpeed)
            }

            Spacer(minLength: 0)

            HStack(spacing: 8) {
                if !firstRun {
                    Button(action: done) {
                        Text("Cancel")
                            .font(.system(size: 14, weight: .semibold))
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .overlay(RoundedRectangle(cornerRadius: 11).stroke(Color.white.opacity(0.2)))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.cancelAction)
                }
                Button(action: save) {
                    Text(firstRun ? "Start mining" : "Save")
                        .font(.system(size: 14, weight: .bold))
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .foregroundColor(Theme.darkBlue)
                        .background(addressOK ? Theme.accent : Theme.accent.opacity(0.35))
                        .clipShape(RoundedRectangle(cornerRadius: 11))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!addressOK)
                .keyboardShortcut(.defaultAction)
            }
            VStack(spacing: 1) {
                Text("Pool fee 0.5% · 1% bonus to the block finder")
                Text("Payouts every 2 h from 1 BEAM")
                HStack(spacing: 0) {
                    Text("GPU mining runs ")
                    LinkButton(url: Links.mxbm) { Text("MXBM").foregroundColor(Theme.accent) }
                    Text(" by maxnflaxl")
                }
                Text("MXBM dev fee: 1%, 36 sec per hour")
            }
            .font(.system(size: 10.5)).foregroundColor(Theme.muted)
            .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 14)
        .frame(maxHeight: .infinity)
        .overlay(alignment: .topTrailing) {
            Text("v" + AppInfo.version).font(Theme.mono(10)).foregroundColor(Theme.muted)
                .padding(.top, 12).padding(.trailing, 14)
        }
        .onAppear {
            address = settings.address; worker = settings.worker
            mode = settings.mode; showRate = settings.showRate
            atLogin = LoginItem.enabled && settings.startOnLaunch; shareSpeed = settings.shareSpeed
        }
    }

    private var addressOK: Bool { Settings.check(address) == .publicOffline }

    private var addressNote: (String, Color) {
        switch Settings.check(address) {
        case .empty: return ("Use a public offline address from your Beam wallet", Theme.muted)
        case .publicOffline: return ("✓ Public offline address", Theme.accent)
        case .offline: return ("This is an offline address: use a public offline one", Theme.yellow)
        case .maxPrivacy: return ("This is a max privacy address: use a public offline one", Theme.yellow)
        case .regular: return ("This is a regular address: use a public offline one", Theme.yellow)
        case .invalid: return ("This does not look like a Beam address", Theme.red)
        }
    }

    private func save() {
        let a = address.trimmingCharacters(in: .whitespacesAndNewlines)
        let w = worker.trimmingCharacters(in: .whitespaces).isEmpty ? Settings.defaultWorker() : worker
        let changed = a != settings.address || w != settings.worker || mode != settings.mode
        settings.address = a
        settings.worker = w
        settings.mode = mode
        settings.showRate = showRate
        settings.shareSpeed = shareSpeed
        if !firstRun && atLogin != (LoginItem.enabled && settings.startOnLaunch) {
            settings.startOnLaunch = atLogin
            LoginItem.set(atLogin)
        }
        pool.fetchMiner()
        if firstRun { miner.start() } else if changed { miner.restartIfRunning() }
        done()
    }
}
