import Foundation
import IOKit
import IOKit.ps

/// Whether the Mac runs on its power adapter, updated as soon as the adapter is plugged in or out.
final class PowerSource: ObservableObject {
    @Published private(set) var onAC = PowerSource.read()
    private var source: CFRunLoopSource?

    init() {
        let ctx = Unmanaged.passUnretained(self).toOpaque()
        source = IOPSNotificationCreateRunLoopSource({ ctx in
            guard let ctx else { return }
            let me = Unmanaged<PowerSource>.fromOpaque(ctx).takeUnretainedValue()
            let now = PowerSource.read()
            if now != me.onAC { me.onAC = now }
        }, ctx)?.takeRetainedValue()
        if let source { CFRunLoopAddSource(CFRunLoopGetMain(), source, .defaultMode) }
    }

    static func read() -> Bool {
        guard let t = IOPSGetProvidingPowerSourceType(nil)?.takeUnretainedValue() as String? else { return true }
        return t == kIOPMACPowerKey
    }
}

/// The miner's GPU power in watts. IOReport's "Energy Model" group (the counters powermetrics
/// reads, no root needed) gives the whole GPU's energy; the miner's part of it is its share of the
/// GPU time all processes used, which the GPU driver keeps per process in the I/O Registry
/// ("AppUsage" of each Metal client). IOReport is a private library, looked up at run time; on a
/// Mac without either reading (Intel GPUs) there is simply no figure.
final class GPUPower: ObservableObject {
    @Published private(set) var watts: Double?
    /// the process whose share is measured (the miner), 0 for none
    var pid: pid_t = 0
    private var lastTimes: [pid_t: UInt64] = [:]

    private typealias CopyChannels = @convention(c) (CFString, CFString?, UInt64, UInt64, UInt64) -> Unmanaged<CFDictionary>?
    private typealias CreateSub = @convention(c) (UnsafeRawPointer?, CFMutableDictionary, UnsafeMutablePointer<Unmanaged<CFMutableDictionary>?>, UInt64, CFTypeRef?) -> OpaquePointer?
    private typealias CreateSamples = @convention(c) (OpaquePointer, CFMutableDictionary, CFTypeRef?) -> Unmanaged<CFDictionary>?
    private typealias Delta = @convention(c) (CFDictionary, CFDictionary, CFTypeRef?) -> Unmanaged<CFDictionary>?
    private typealias GetString = @convention(c) (CFDictionary) -> Unmanaged<CFString>?
    private typealias GetInt = @convention(c) (CFDictionary, Int32) -> Int64

    private var createSamples: CreateSamples?
    private var delta: Delta?
    private var name: GetString?
    private var unit: GetString?
    private var value: GetInt?
    private var sub: OpaquePointer?
    private var subChannels: CFMutableDictionary?
    private var last: CFDictionary?
    private var lastAt = Date()
    private var timer: Timer?

    init() {
        guard let h = dlopen("/usr/lib/libIOReport.dylib", RTLD_NOW) else { return }
        func sym<T>(_ n: String, _: T.Type) -> T? { dlsym(h, n).map { unsafeBitCast($0, to: T.self) } }
        guard let copy = sym("IOReportCopyChannelsInGroup", CopyChannels.self),
              let create = sym("IOReportCreateSubscription", CreateSub.self) else { return }
        createSamples = sym("IOReportCreateSamples", CreateSamples.self)
        delta = sym("IOReportCreateSamplesDelta", Delta.self)
        name = sym("IOReportChannelGetChannelName", GetString.self)
        unit = sym("IOReportChannelGetUnitLabel", GetString.self)
        value = sym("IOReportSimpleGetIntegerValue", GetInt.self)
        guard let ch = copy("Energy Model" as CFString, nil, 0, 0, 0)?.takeRetainedValue(),
              let m = CFDictionaryCreateMutableCopy(kCFAllocatorDefault, 0, ch) else { return }
        var out: Unmanaged<CFMutableDictionary>?
        sub = create(nil, m, &out, 0, nil)
        subChannels = out?.takeRetainedValue()
    }

    /// Sample every 2 s while `on`; off clears the reading.
    func run(_ on: Bool) {
        if on, timer == nil {
            last = sample(); lastAt = Date(); lastTimes = GPUPower.gpuTimes()
            timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.tick() }
        } else if !on {
            timer?.invalidate(); timer = nil
            watts = nil
        }
    }

    private func sample() -> CFDictionary? {
        guard let sub, let subChannels, let createSamples else { return nil }
        return createSamples(sub, subChannels, nil)?.takeRetainedValue()
    }

    private func tick() {
        guard let prev = last, let cur = sample(), let delta, let name, let value else { return }
        let dt = Date().timeIntervalSince(lastAt)
        last = cur; lastAt = Date()
        guard dt > 0.2, let d = delta(prev, cur, nil)?.takeRetainedValue(),
              let channels = (d as NSDictionary)["IOReportChannels"] as? [NSDictionary] else { return }
        let times = GPUPower.gpuTimes()
        defer { lastTimes = times }
        var all: UInt64 = 0, mine: UInt64 = 0
        for (p, t) in times {
            let d = t &- (lastTimes[p] ?? t)
            guard d < UInt64(dt * 4e9) else { continue }   // a pid reused or a counter reset
            all += d
            if p == pid { mine += d }
        }
        guard pid > 0, all > 0 else { watts = nil; return }
        var joules = 0.0
        for c in channels {
            let cd = c as CFDictionary
            guard (name(cd)?.takeUnretainedValue() as String?) == "GPU Energy" else { continue }
            let u = unit?(cd)?.takeUnretainedValue() as String? ?? ""
            let v = Double(value(cd, 0))
            joules += u == "mJ" ? v / 1e3 : u == "uJ" ? v / 1e6 : u == "nJ" ? v / 1e9 : 0
        }
        watts = joules / dt * Double(mine) / Double(all)
    }

    /// Accumulated GPU time in ns by process, from every Metal client under the GPU's accelerator.
    static func gpuTimes() -> [pid_t: UInt64] {
        var out: [pid_t: UInt64] = [:]
        var it: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &it) == KERN_SUCCESS else { return out }
        defer { IOObjectRelease(it) }
        var acc = IOIteratorNext(it)
        while acc != 0 {
            var children: io_iterator_t = 0
            if IORegistryEntryCreateIterator(acc, kIOServicePlane, IOOptionBits(kIORegistryIterateRecursively), &children) == KERN_SUCCESS {
                var e = IOIteratorNext(children)
                while e != 0 {
                    if let creator = IORegistryEntryCreateCFProperty(e, "IOUserClientCreator" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String,
                       let usage = IORegistryEntryCreateCFProperty(e, "AppUsage" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? [[String: Any]],
                       creator.hasPrefix("pid "), let p = pid_t(creator.dropFirst(4).prefix { $0.isNumber }) {
                        out[p, default: 0] += usage.reduce(0) { $0 + ((($1["accumulatedGPUTime"] as? NSNumber)?.uint64Value) ?? 0) }
                    }
                    IOObjectRelease(e)
                    e = IOIteratorNext(children)
                }
                IOObjectRelease(children)
            }
            IOObjectRelease(acc)
            acc = IOIteratorNext(it)
        }
        return out
    }
}
