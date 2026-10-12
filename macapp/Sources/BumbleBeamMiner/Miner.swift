import Foundation
import IOKit.ps
import IOKit.pwr_mgt

enum MinerState: Equatable {
    case stopped
    case starting
    case mining
    case noConnection(String)
}

/// Runs one miner process at a time and reads its output.
/// GPU: bundled MXBM with the Metal solver, patched with a load limit (vendor/0004-metal-load-limit.patch):
/// below 100% fewer threadgroups run at once, so fewer GPU cores work and the GPU draws less power.
/// The power goes through a file MXBM re-reads before every solve, so the slider acts at once.
/// CPU: bundled bumblebeam-miner; power picks the number of threads.
final class Miner: ObservableObject {
    static let stratumHost = "stratum.bumblebeam.org"

    @Published private(set) var state: MinerState = .stopped
    @Published private(set) var rate: Double = 0          // sol/s, as the miner reports it
    @Published private(set) var accepted = 0
    @Published private(set) var rejected = 0
    @Published private(set) var history: [Double] = []   // recent rate samples, oldest first
    @Published private(set) var startedAt: Date?
    @Published private(set) var lastLine = ""
    /// The miner process's pid while it runs (for its share of the GPU's power)
    @Published private(set) var pid: pid_t = 0

    private let settings: Settings
    private var process: Process?
    private var userStopped = true
    private var restartWork: DispatchWorkItem?
    private var buffer = Data()
    private var logHandle: FileHandle?
    private var logBytes = 0
    private var ptyReader: FileHandle?
    /// Bumped at every launch: output still in flight from a process that was replaced is dropped.
    private var generation = 0
    /// bumblebeam-miner counts its own shares from zero; what earlier runs of this session counted
    private var countedBefore = (ok: 0, bad: 0)

    // keep awake
    private var sleepAssertion: IOPMAssertionID = 0
    private var awakeTimer: Timer?

    init(settings: Settings) {
        self.settings = settings
        awakeTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.updateAwake() }
    }

    var running: Bool { state != .stopped }

    static var bundleDir: URL { Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS") }
    static var workDir: URL {
        let u = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("BumbleBeam Miner", isDirectory: true)
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }
    static var loadFile: URL { workDir.appendingPathComponent("gpu-load") }
    static var logURL: URL {
        let u = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs/BumbleBeam Miner", isDirectory: true)
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u.appendingPathComponent("miner.log")
    }

    static var cpuThreads: Int { ProcessInfo.processInfo.activeProcessorCount }
    static func threads(forPower p: Int) -> Int { max(1, Int((Double(cpuThreads) * Double(p) / 100).rounded())) }

    // MARK: start / stop

    func start() {
        guard settings.configured else { return }
        userStopped = false
        restartWork?.cancel()
        terminate(wait: true)   // never two miners at once
        accepted = 0; rejected = 0; rate = 0; history = []
        countedBefore = (0, 0)
        startedAt = Date()
        launch()
    }

    /// Stop from the window: the miner is told to quit and waited for off the main thread, so the
    /// window does not freeze while a GPU miner winds down.
    func stop() { halt(wait: false) }

    /// Stop before the app exits: waits for the miner, which would otherwise outlive the app.
    func stopNow() { halt(wait: true) }

    private func halt(wait: Bool) {
        userStopped = true
        restartWork?.cancel()
        terminate(wait: wait)
        state = .stopped
        rate = 0
        startedAt = nil
        updateAwake()
    }

    /// Settings that change the command line (device, CPU power, address, worker, mode) restart it.
    func restartIfRunning() {
        guard running else { return }
        rate = 0; history = []   // a new command line, maybe another device: a new curve
        state = .starting
        // the old miner lets go of its memory (7 GB for the CPU one) before the new one starts
        terminate(wait: false) { [weak self] in
            guard let self, !self.userStopped, self.process == nil else { return }
            self.launch()
        }
    }

    /// Power changed: GPU follows at its next solve through the load file, CPU restarts with new threads.
    func powerChanged() {
        writeLoad()
        guard running, settings.device == .cpu else { return }
        restartIfRunning()
    }

    private func writeLoad() {
        try? "\(settings.power)\n".write(to: Miner.loadFile, atomically: true, encoding: .utf8)
    }

    private func launch() {
        generation += 1
        let gen = generation
        countedBefore = (accepted, rejected)
        let p = Process()
        let port = settings.mode == .solo ? 3444 : 3443
        let user = "\(settings.address.trimmingCharacters(in: .whitespacesAndNewlines)).\(settings.cleanWorker)"
        switch settings.device {
        case .gpu:
            p.executableURL = Miner.bundleDir.appendingPathComponent("mxbm")
            p.arguments = ["--algo", "BEAM-III", "--solver", "metal",
                           "--pool", "\(Miner.stratumHost):\(port)", "--tls", "1", "--user", user]
        case .cpu:
            p.executableURL = Miner.bundleDir.appendingPathComponent("bumblebeam-miner")
            p.arguments = ["mine", "--pool", "\(Miner.stratumHost):\(port)", "--tls", "1", "--user", user,
                           "--threads", String(Miner.threads(forPower: settings.power))]
        }
        p.currentDirectoryURL = Miner.workDir
        var env = ProcessInfo.processInfo.environment
        env["NO_COLOR"] = "1"
        if settings.device == .gpu {
            writeLoad()
            env["MXBM_METAL_LOAD"] = String(settings.power)
            env["MXBM_METAL_LOAD_FILE"] = Miner.loadFile.path
        }
        p.environment = env

        // The miner writes to a pseudo-terminal rather than a pipe: into a pipe its C library
        // buffers whole blocks, so shares and speed would reach the window minutes late.
        var master: Int32 = -1, slave: Int32 = -1
        guard openpty(&master, &slave, nil, nil, nil) == 0 else {
            retry("Could not start the miner: no terminal for its output")
            return
        }
        var term = termios()
        if tcgetattr(slave, &term) == 0 { term.c_oflag &= ~tcflag_t(OPOST); tcsetattr(slave, TCSANOW, &term) }
        let out = FileHandle(fileDescriptor: slave, closeOnDealloc: true)
        let reader = FileHandle(fileDescriptor: master, closeOnDealloc: true)
        p.standardOutput = out
        p.standardError = out
        p.standardInput = FileHandle.nullDevice
        buffer = Data()
        openLog()
        reader.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty else { h.readabilityHandler = nil; return }
            DispatchQueue.main.async {
                guard let self, self.generation == gen else { return }
                self.consume(data)
            }
        }
        ptyReader = reader
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.exited(proc) }
        }
        do {
            try p.run()
        } catch {
            closeOutput()
            retry("Could not start the miner: \(error.localizedDescription)")
            return
        }
        process = p
        pid = p.processIdentifier
        try? out.close()   // the child holds its own copy of the terminal's slave end
        state = .starting
        updateAwake()
    }

    /// Asks the miner to quit, and kills it if it has not after 3 s. `wait` blocks until then;
    /// otherwise the waiting happens off the main thread and `then` runs on main once it is gone.
    private func terminate(wait: Bool, then: (() -> Void)? = nil) {
        guard let p = process else { then?(); return }
        process = nil
        pid = 0
        p.terminationHandler = nil
        generation += 1   // its last output is not this session's any more
        closeOutput()
        let reap = {
            if p.isRunning {
                p.terminate()
                let deadline = Date().addingTimeInterval(3)
                while p.isRunning && Date() < deadline { usleep(50_000) }
                if p.isRunning { kill(p.processIdentifier, SIGKILL); usleep(100_000) }
            }
        }
        if wait {
            reap(); then?()
        } else {
            DispatchQueue.global(qos: .userInitiated).async {
                reap()
                if let then { DispatchQueue.main.async(execute: then) }
            }
        }
    }

    /// Something went wrong before or after the miner ran: say so and try again in 10 s.
    private func retry(_ why: String) {
        state = .noConnection("\(why). Retrying in 10 s")
        let w = DispatchWorkItem { [weak self] in
            guard let self, !self.userStopped, self.process == nil else { return }
            self.launch()
        }
        restartWork?.cancel()
        restartWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: w)
    }

    private func closeOutput() {
        try? logHandle?.close(); logHandle = nil
        ptyReader?.readabilityHandler = nil
        try? ptyReader?.close(); ptyReader = nil
    }

    private func exited(_ p: Process) {
        guard p === process else { return }
        process = nil
        pid = 0
        closeOutput()
        rate = 0
        if userStopped { state = .stopped; return }
        retry(lastLine.isEmpty ? "The miner stopped (code \(p.terminationStatus))" : lastLine)
    }

    // MARK: output

    private func openLog() {
        let url = Miner.logURL
        if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
        logHandle = try? FileHandle(forWritingTo: url)
        logBytes = Int((try? logHandle?.seekToEnd()) ?? 0)
        let head = "\n=== \(Date()) \(settings.device.rawValue) power \(settings.power)% ===\n"
        writeLog(head.data(using: .utf8)!)
    }

    /// The log is kept under 5 MB while mining: past that it moves to miner.1.log (the one before
    /// is dropped) and a new one starts.
    private func writeLog(_ data: Data) {
        logHandle?.write(data)
        logBytes += data.count
        guard logBytes > 5_000_000 else { return }
        try? logHandle?.close()
        let url = Miner.logURL, old = url.deletingLastPathComponent().appendingPathComponent("miner.1.log")
        try? FileManager.default.removeItem(at: old)
        try? FileManager.default.moveItem(at: url, to: old)
        FileManager.default.createFile(atPath: url.path, contents: nil)
        logHandle = try? FileHandle(forWritingTo: url)
        logBytes = 0
    }

    private func consume(_ data: Data) {
        writeLog(data)
        buffer.append(data)
        while let nl = buffer.firstIndex(where: { $0 == 10 || $0 == 13 }) {
            let lineData = buffer[buffer.startIndex..<nl]
            buffer.removeSubrange(buffer.startIndex...nl)
            guard let raw = String(data: lineData, encoding: .utf8) else { continue }
            let line = Miner.stripANSI(raw).trimmingCharacters(in: .whitespaces)
            if !line.isEmpty { parse(line) }
        }
        if buffer.count > 65536 { buffer.removeAll() }
    }

    static func stripANSI(_ s: String) -> String {
        s.replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[A-Za-z]", with: "", options: .regularExpression)
    }

    private func parse(_ line: String) {
        let l = line.lowercased()
        // MXBM
        if let r = Miner.number(in: line, after: "Average speed") {
            push(rate: r)
        } else if l.hasPrefix("share accepted") {
            accepted += 1; state = .mining
        } else if l.hasPrefix("share rejected") {
            rejected += 1
        } else if l.contains("authorized worker") || l.contains("logged in") {
            state = .mining
        } else if l.contains("connection lost") || l.contains("reconnect") || l.contains("could not connect")
                    || l.contains("connection refused") || l.contains("unauthorized") {
            state = .noConnection(line)
        }
        // bumblebeam-miner status line: "31 s | 0.388 sol/s | 8 runs ... | shares A/R/S 0/0/0 | ..."
        if line.contains("sol/s |"), let r = Miner.number(in: line, after: "|") {
            push(rate: r)
            if let m = line.range(of: #"A/R/S (\d+)/(\d+)/(\d+)"#, options: .regularExpression) {
                let parts = line[m].dropFirst(6).split(separator: "/").compactMap { Int($0) }
                if parts.count == 3 {
                    accepted = countedBefore.ok + parts[0]
                    rejected = countedBefore.bad + parts[1] + parts[2]
                }
            }
            if case .noConnection = state {} else { state = .mining }
        }
        if !line.hasPrefix("Apple") && !line.hasPrefix("Share") && !line.contains("sol/s") { lastLine = line }
    }

    private func push(rate r: Double) {
        rate = r
        history.append(r)
        if history.count > 60 { history.removeFirst(history.count - 60) }
    }

    /// The first decimal number after `marker` that is followed by "sol/s".
    static func number(in s: String, after marker: String) -> Double? {
        guard let r = s.range(of: marker) else { return nil }
        let tail = s[r.upperBound...]
        guard let m = tail.range(of: #"([0-9]+(\.[0-9]+)?)\s*sol/s"#, options: .regularExpression) else { return nil }
        let num = tail[m].split(separator: " ").first.map(String.init)?.replacingOccurrences(of: "sol/s", with: "")
        return num.flatMap(Double.init)
    }

    // MARK: leftovers

    /// Kills miners started from this app's bundle that outlived it (a crash or a force quit
    /// leaves them running: they are not tied to the app), so there is never a second, hidden one.
    static func killLeftovers() {
        let mine = [bundleDir.appendingPathComponent("mxbm").path,
                    bundleDir.appendingPathComponent("bumblebeam-miner").path]
        let n = proc_listallpids(nil, 0)
        guard n > 0 else { return }
        var pids = [pid_t](repeating: 0, count: Int(n) * 2)
        let got = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
        var path = [CChar](repeating: 0, count: 4096)
        for pid in pids.prefix(Int(max(got, 0))) where pid > 0 {
            guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { continue }
            if mine.contains(String(cString: path)) { kill(pid, SIGTERM) }
        }
    }

    // MARK: keep awake

    func updateAwake() {
        let want = running && (PowerSource.read() ? settings.keepAwake : settings.keepAwakeOnBattery)
        if want && sleepAssertion == 0 {
            IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                                        IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                        "BumbleBeam Miner is mining" as CFString, &sleepAssertion)
        } else if !want && sleepAssertion != 0 {
            IOPMAssertionRelease(sleepAssertion)
            sleepAssertion = 0
        }
    }

    var keepingAwake: Bool { sleepAssertion != 0 }
}
