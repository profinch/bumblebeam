import Foundation

enum Device: String { case gpu, cpu }
enum PayoutMode: String { case pplns, solo }

/// What the miner is told to do, kept in UserDefaults.
final class Settings: ObservableObject {
    private let d = UserDefaults.standard

    @Published var address: String { didSet { d.set(address, forKey: "address") } }
    @Published var worker: String { didSet { d.set(worker, forKey: "worker") } }
    @Published var device: Device { didSet { d.set(device.rawValue, forKey: "device") } }
    @Published var mode: PayoutMode { didSet { d.set(mode.rawValue, forKey: "mode") } }
    /// 10...100, step 10
    @Published var power: Int { didSet { d.set(power, forKey: "power") } }
    /// Keep the Mac awake while mining on the adapter: the user's choice, remembered.
    @Published var keepAwake: Bool { didSet { d.set(keepAwake, forKey: "keepAwake") } }
    /// The same on battery: off whenever the adapter is pulled, the user may turn it on.
    @Published var keepAwakeOnBattery = false
    @Published var showRate: Bool { didSet { d.set(showRate, forKey: "showRate") } }
    @Published var startOnLaunch: Bool { didSet { d.set(startOnLaunch, forKey: "startOnLaunch") } }
    /// Send average speeds to the pool (POST /api/benchmarks); off unless the user turns it on.
    @Published var shareSpeed: Bool { didSet { d.set(shareSpeed, forKey: "shareSpeed") } }

    init() {
        address = d.string(forKey: "address") ?? ""
        worker = d.string(forKey: "worker") ?? Settings.defaultWorker()
        device = Device(rawValue: d.string(forKey: "device") ?? "") ?? .gpu
        mode = PayoutMode(rawValue: d.string(forKey: "mode") ?? "") ?? .pplns
        power = d.object(forKey: "power") as? Int ?? 80
        keepAwake = d.object(forKey: "keepAwake") as? Bool ?? true
        showRate = d.object(forKey: "showRate") as? Bool ?? true
        startOnLaunch = d.object(forKey: "startOnLaunch") as? Bool ?? false
        shareSpeed = d.object(forKey: "shareSpeed") as? Bool ?? false
    }

    var configured: Bool { !address.isEmpty }

    /// The worker name as the pool will see it: ASCII letters, digits, '-' and '_'.
    var cleanWorker: String {
        let ok = worker.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
        return ok.isEmpty ? "mac" : String(ok.prefix(32))
    }

    static func defaultWorker() -> String { "bumblebeam" }

    /// The address types of the Beam wallet. Only public offline addresses are taken for now:
    /// the kind the desktop wallet gives by default, a long base58 string.
    enum AddressCheck { case empty, publicOffline, offline, maxPrivacy, regular, invalid }

    /// Beam's own rules (wallet/core/common.cpp, GetAddressTypeImpl) on the parameters packed in
    /// the address. The base58 bytes are a TxToken: a flags byte (0x80), an optional 16-byte
    /// TxID behind a presence byte, then a count and (parameter id, byte buffer) pairs. Counts,
    /// ids and lengths are yas "compacted" integers: a byte with the top bit set is the value
    /// itself in its low 7 bits, otherwise it says how many little-endian bytes follow.
    static func check(_ a: String) -> AddressCheck {
        let s = a.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return .empty }
        let hex = Set("0123456789abcdefABCDEF")
        if (64...70).contains(s.count) && s.allSatisfy({ hex.contains($0) }) { return .regular }
        guard let b = base58(s), let p = tokenParameters(b) else { return .invalid }
        // TransactionType (0) holds a compacted TxType: 0 simple, 1 atomic swap, 7 push
        if let t = p[0], let type = compacted(t, at: 0)?.value {
            if type == 0 { return .regular }
            if type != 7 { return .invalid }
        }
        let peerAddr = p[7] != nil, endpoint = p[21] != nil
        if p[125] != nil && endpoint { return .maxPrivacy }                    // Voucher
        if let v = p[124], v.count > 1, endpoint && peerAddr { return .offline } // ShieldedVoucherList
        if p[123] != nil { return .publicOffline }                              // PublicAddreessGen
        if peerAddr { return .regular }
        return .invalid
    }

    private static func compacted(_ b: [UInt8], at i: Int) -> (value: UInt64, next: Int)? {
        guard i < b.count else { return nil }
        let x = b[i]
        if x & 0x80 != 0 { return (UInt64(x & 0x7f), i + 1) }
        let n = Int(x)
        guard n <= 8, i + 1 + n <= b.count else { return nil }
        var v: UInt64 = 0
        for k in 0..<n { v |= UInt64(b[i + 1 + k]) << (8 * UInt64(k)) }
        return (v, i + 1 + n)
    }

    private static func tokenParameters(_ b: [UInt8]) -> [UInt64: [UInt8]]? {
        guard b.count > 3, b[0] & 0x80 != 0 else { return nil }
        var i = 1
        if b[i] != 0 { i += 16 }   // a TxID is present
        i += 1
        guard let count = compacted(b, at: i), count.value < 256 else { return nil }
        i = count.next
        var out: [UInt64: [UInt8]] = [:]
        for _ in 0..<count.value {
            guard let id = compacted(b, at: i), let len = compacted(b, at: id.next) else { return nil }
            let start = len.next, end = start + Int(len.value)
            guard end <= b.count else { return nil }
            out[id.value] = Array(b[start..<end])
            i = end
        }
        return i == b.count ? out : nil
    }

    static func base58(_ s: String) -> [UInt8]? {
        let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
        var out: [UInt8] = []          // big-endian, grown as digits come in
        for c in s {
            guard var carry = alphabet.firstIndex(of: c) else { return nil }
            for j in stride(from: out.count - 1, through: 0, by: -1) {
                carry += Int(out[j]) * 58
                out[j] = UInt8(carry & 0xff)
                carry >>= 8
            }
            while carry > 0 { out.insert(UInt8(carry & 0xff), at: 0); carry >>= 8 }
        }
        let zeros = s.prefix { $0 == "1" }.count
        return [UInt8](repeating: 0, count: zeros) + out
    }
}
