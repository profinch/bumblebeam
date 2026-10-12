import Foundation
import IOKit
import ServiceManagement

/// What the machine is, for speed reports: model, chip, cores, system.
enum Machine {
    static func sysctl(_ name: String) -> String {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return "" }
        var buf = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &buf, &size, nil, 0) == 0 else { return "" }
        return String(cString: buf)
    }

    /// "Apple M5 Pro", or the Intel CPU's name
    static let chip: String = {
        let s = sysctl("machdep.cpu.brand_string")
        return s.isEmpty ? "This Mac" : s
    }()
    /// "Mac17,1", "MacBookPro16,1"...
    static let model = sysctl("hw.model")
    /// arm64 or x86_64; an Intel build running under Rosetta still says arm64 (the machine)
    static let arch: String = {
        var translated: Int32 = 0, size = MemoryLayout<Int32>.size
        if sysctlbyname("sysctl.proc_translated", &translated, &size, nil, 0) == 0, translated == 1 { return "arm64" }
        #if arch(arm64)
        return "arm64"
        #else
        return "x86_64"
        #endif
    }()
    static let os: String = {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "macOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }()
    /// GPU cores on Apple silicon (the driver's "gpu-core-count"), nil elsewhere
    static let gpuCores: Int? = {
        var it: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("AGXAccelerator"), &it) == KERN_SUCCESS else { return nil }
        defer { IOObjectRelease(it) }
        let svc = IOIteratorNext(it)
        guard svc != 0 else { return nil }
        defer { IOObjectRelease(svc) }
        return (IORegistryEntryCreateCFProperty(svc, "gpu-core-count" as CFString, kCFAllocatorDefault, 0)?
            .takeRetainedValue() as? NSNumber)?.intValue
    }()
}

/// The "Share average speed" switch (off by default): after 30 minutes of steady mining on one
/// device and power, the average speed and the machine go to POST /api/benchmarks, no address.
/// At most one report per device and power every 6 hours. The reports become per-model speeds
/// in the app later.
final class SpeedReporter {
    private let settings: Settings
    private let miner: Miner
    private let gpu: GPUPower
    private var timer: Timer?
    private var key = ""
    private var since = Date()
    private var rates: [Double] = []
    private var watts: [Double] = []

    init(settings: Settings, miner: Miner, gpu: GPUPower) {
        self.settings = settings
        self.miner = miner
        self.gpu = gpu
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.tick() }
    }

    private func tick() {
        guard settings.shareSpeed, miner.state == .mining, miner.rate > 0 else { reset(""); return }
        let k = "\(settings.device.rawValue)-\(settings.power)"
        guard k == key else { reset(k); return }
        guard Date().timeIntervalSince(since) > 120 else { return }   // let the speed settle
        rates.append(miner.rate)
        if let w = gpu.watts, settings.device == .gpu { watts.append(w) }
        guard rates.count >= 30 else { return }
        let sentKey = "speedReported-\(k)"
        let last = UserDefaults.standard.double(forKey: sentKey)
        let avg = rates.reduce(0, +) / Double(rates.count)
        var body: [String: Any] = [
            "app": AppInfo.version, "os": Machine.os, "arch": Machine.arch, "model": Machine.model.isEmpty ? "unknown" : Machine.model,
            "chip": Machine.chip, "cpuThreads": Miner.cpuThreads, "device": settings.device.rawValue,
            "power": settings.power, "solPerSec": (avg * 100).rounded() / 100, "minutes": rates.count,
        ]
        if let c = Machine.gpuCores { body["gpuCores"] = c }
        if !watts.isEmpty { body["gpuWatts"] = ((watts.reduce(0, +) / Double(watts.count)) * 10).rounded() / 10 }
        reset(k)
        guard Date().timeIntervalSince1970 - last > 6 * 3600 else { return }
        Pool.report(body) { ok in
            if ok { UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: sentKey) }
        }
    }

    private func reset(_ k: String) {
        key = k; since = Date(); rates = []; watts = []
    }
}

/// "Start mining at login": the app as a login item (macOS 13 and later).
enum LoginItem {
    static var available: Bool {
        if #available(macOS 13.0, *) { return true }
        return false
    }

    static var enabled: Bool {
        if #available(macOS 13.0, *) { return SMAppService.mainApp.status == .enabled }
        return false
    }

    /// Returns false when macOS refused (the user then allows it in System Settings › Login Items).
    @discardableResult
    static func set(_ on: Bool) -> Bool {
        guard #available(macOS 13.0, *) else { return false }
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            return true
        } catch {
            return false
        }
    }
}
