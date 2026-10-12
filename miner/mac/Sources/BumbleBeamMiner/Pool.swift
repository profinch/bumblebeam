import Foundation

/// Reads the miner's balance and what the pool sees from pool.bumblebeam.org.
final class Pool: ObservableObject {
    static let base = URL(string: "https://pool.bumblebeam.org")!

    @Published private(set) var balance: Double?      // BEAM
    @Published private(set) var immature: Double?
    @Published private(set) var workerRate: Double?   // sol/s the pool sees for this worker
    @Published private(set) var blocksTotal: Int?     // blocks this address's shares found, all workers
    @Published private(set) var blocksSession = 0     // found by this Mac's worker since Start
    @Published private(set) var networkRate: Double?  // sol/s
    @Published private(set) var blockReward = 25.0    // BEAM
    @Published private(set) var fee = 0.5             // percent
    /// Set while the pool site does not answer; balances and counts then are the last ones read.
    @Published private(set) var unreachable = false

    private let settings: Settings
    private var timer: Timer?
    private var lastStats = Date.distantPast
    private var sessionStart: Date?

    init(settings: Settings) {
        self.settings = settings
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.refresh() }
        refresh()
    }

    /// BEAM a day at `rate` sol/s, after the pool fee.
    func perDay(rate: Double) -> Double? {
        guard let net = networkRate, net > 0, rate > 0 else { return nil }
        return rate / net * 1440 * blockReward * (1 - fee / 100)
    }

    /// Mining started: blocks this worker finds from now on count for the session.
    func startSession() {
        sessionStart = Date()
        blocksSession = 0
        fetchMiner()
    }

    func refresh() {
        if Date().timeIntervalSince(lastStats) > 300 || networkRate == nil { fetchStats() }
        fetchMiner()
    }

    private func get(_ url: URL, _ done: @escaping (Int, [String: Any]?) -> Void) {
        var req = URLRequest(url: url)
        req.timeoutInterval = 15
        URLSession.shared.dataTask(with: req) { data, resp, err in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async {
                // a network error or the site's own failure; a 404 for a new address is an answer
                self.unreachable = err != nil || code >= 500 || code == 0
                done(code, obj)
            }
        }.resume()
    }

    private func fetchStats() {
        get(Pool.base.appendingPathComponent("api/stats")) { _, o in
            guard let o else { return }
            self.lastStats = Date()
            if let nodes = o["nodes"] as? [[String: Any]], let n = nodes.first,
               let s = n["networkhashps"], let v = Double("\(s)") { self.networkRate = v }
            if let c = o["config"] as? [String: Any] {
                if let r = c["blockReward"] as? Double { self.blockReward = r / 1e8 }
                if let f = c["fee"] as? Double { self.fee = f }
            }
        }
    }

    func fetchMiner() {
        let a = settings.address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Settings.check(a) == .publicOffline,
              var c = URLComponents(url: Pool.base.appendingPathComponent("api/miners/\(a)"), resolvingAgainstBaseURL: false)
        else { return }
        if let start = sessionStart {
            // the server counts this worker's blocks since Start (GET /api/miners/<address>?worker=&since=)
            c.queryItems = [URLQueryItem(name: "worker", value: settings.cleanWorker),
                            URLQueryItem(name: "since", value: String(Int(start.timeIntervalSince1970)))]
        }
        guard let url = c.url else { return }
        get(url) { code, o in
            guard code == 200, let o else {
                if code == 404 { self.balance = 0; self.immature = 0; self.workerRate = nil; self.blocksTotal = 0 }
                return
            }
            self.balance = (o["balance"] as? Double).map { $0 / 1e8 }
            self.immature = (o["immature"] as? Double).map { $0 / 1e8 }
            let w = (o["workers"] as? [[String: Any]])?.first { ($0["name"] as? String) == self.settings.cleanWorker }
            self.workerRate = w?["hashrate"] as? Double
            self.blocksTotal = (o["blocksFound"] as? NSNumber)?.intValue
            if self.sessionStart != nil, let n = (o["blocksSince"] as? NSNumber)?.intValue { self.blocksSession = n }
        }
    }

    /// Sends one average-speed report (POST /api/benchmarks); only called when the user shares speed.
    static func report(_ body: [String: Any], done: @escaping (Bool) -> Void) {
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return done(false) }
        var req = URLRequest(url: base.appendingPathComponent("api/benchmarks"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = data
        req.timeoutInterval = 15
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }
}
