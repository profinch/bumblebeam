#!/usr/bin/env python3
"""bbkangaroo pool server (MVP).

Workers run bbkangaroo with -db and send the new records of <db>.journal here (pool_client.py). Every record is
verified by one scalar multiplication (tame: x(d*G), wild: x(+-PntA + d*G)), so a record is a proof of about 2^DP
jumps of work and cannot be faked cheaper than by walking. Verified records go into one table keyed by the low 8
bytes of x; a second record with the same x and a different (type, d) is a collision, and the key candidates are
tried against the target public key. Shares are counted per worker by verified records.

Record format (bbkangaroo BBKDB002): x[8] little-endian low bytes of x, then DLEN = ceil((range + 8) / 8) bytes of
distance, two's complement little-endian, with the herd type (0 tame, 1 wild1, 2 wild2) in the top two bits of the
last byte. The record length is 8 + DLEN.

Run: pool_server.py --job job.json --port 8800 [--store pool_records.bin]
job.json: {"range": 52, "start": "8000000000000", "pubkey": "02..", "dp": 10, "jumps_hash": "hex16"}
"""
import argparse, json, os, struct, threading, time
from aiohttp import web
from coincurve import PrivateKey, PublicKey

N_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
TAME, WILD1, WILD2 = 0, 1, 2


def dlen_for_range(r: int) -> int:
    return min((r + 15) // 8, 22)


def neg(pk: PublicKey) -> PublicKey:
    return pk.multiply((N_ORDER - 1).to_bytes(32, "big"))


def point_of_scalar(k: int) -> PublicKey | None:
    k %= N_ORDER
    if k == 0:
        return None
    return PrivateKey(k.to_bytes(32, "big")).public_key


def add(a: PublicKey | None, b: PublicKey | None) -> PublicKey | None:
    if a is None:
        return b
    if b is None:
        return a
    try:
        return a.combine([b])
    except Exception:
        return None  # a + (-a) = infinity


def x_low8(pk: PublicKey) -> bytes:
    x = pk.format(compressed=False)[1:33]  # big-endian x
    return x[::-1][:8]  # little-endian low 8 bytes, as bbkangaroo stores them


def decode_rec(rec: bytes) -> tuple[bytes, int, int]:
    """-> (x8, type, d); the type sits in the top two bits of the last byte, the sign bit just below it."""
    x8, db = rec[:8], bytearray(rec[8:])
    typ = db[-1] >> 6
    db[-1] &= 0x3F
    if db[-1] & 0x20:
        db[-1] |= 0xC0
    return x8, typ, int.from_bytes(bytes(db), "little", signed=True)


class Pool:
    def __init__(self, job: dict, store: str):
        self.range = int(job["range"])
        self.rec = 8 + dlen_for_range(self.range)
        self.dp = int(job["dp"])
        self.start = int(job["start"], 16)
        self.jumps_hash = job["jumps_hash"].lower()
        self.pubkey_hex = job["pubkey"].lower()
        self.Q = PublicKey(bytes.fromhex(self.pubkey_hex))
        n = 1 << self.range
        # PntToSolve = Q - start*G ; PntA = PntToSolve - (N/2)*G ; PntB = -PntA
        self.PntToSolve = add(self.Q, neg(point_of_scalar(self.start))) if self.start else self.Q
        self.PntA = add(self.PntToSolve, neg(point_of_scalar(n >> 1)))
        self.PntB = neg(self.PntA)
        self.lock = threading.Lock()
        self.table: dict[bytes, tuple[int, int, str]] = {}  # x8 -> (type, d, worker)
        self.shares: dict[str, int] = {}
        self.bad: dict[str, int] = {}
        self.mirror = 0
        self.solved: dict | None = None
        self.store = store
        self.t0 = time.time()
        if store and os.path.exists(store):
            self._load_store()
        self.store_fp = open(store, "ab") if store else None

    def _load_store(self):
        with open(self.store, "rb") as f:
            data = f.read()
        rl = self.rec + 16
        for i in range(0, len(data) - len(data) % rl, rl):
            rec = data[i:i + self.rec]
            w = data[i + self.rec:i + rl].rstrip(b"\0").decode(errors="replace")
            x8, typ, d = decode_rec(rec)
            self.table[x8] = (typ, d, w)
            self.shares[w] = self.shares.get(w, 0) + 1
        print(f"store: {len(self.table)} records loaded")

    def point(self, typ: int, d: int) -> PublicKey | None:
        P = point_of_scalar(d)  # d may be negative: reduced mod n, so the point is already -(|d|*G)
        if typ == WILD1:
            P = add(self.PntA, P)
        elif typ == WILD2:
            P = add(self.PntB, P)
        return P

    def verify(self, x8: bytes, typ: int, d: int) -> bool:
        P = self.point(typ, d)
        return P is not None and x_low8(P) == x8

    def candidates(self, t1: int, d1: int, t2: int, d2: int) -> list[int]:
        c = []
        if t1 == TAME and t2 != TAME:
            t, w, wt = d1, d2, t2
        elif t2 == TAME and t1 != TAME:
            t, w, wt = d2, d1, t1
        else:
            t = None
        if t is not None:
            if wt == WILD1:
                c += [t - w, -t - w]
            else:
                c += [w - t, w + t]
        else:
            s = d1 + d2
            df = d1 - d2
            for v in (s, -s, df, -df):
                if v % 2 == 0:
                    c.append(v // 2)
        return c

    def try_solve(self, c_list: list[int]) -> int | None:
        half = 1 << (self.range - 1)
        for kp in c_list:
            k0 = kp + half
            k = k0 + self.start
            if 0 < k < N_ORDER:
                P = point_of_scalar(k)
                if P is not None and P.format() == self.Q.format():
                    return k
        return None

    def submit(self, worker: str, blob: bytes) -> dict:
        good = bad = dup = 0
        found = None
        R = self.rec
        for i in range(0, len(blob) - len(blob) % R, R):
            rec = blob[i:i + R]
            x8, typ, d = decode_rec(rec)
            if typ > 2 or not self.verify(x8, typ, d):
                bad += 1
                continue
            with self.lock:
                old = self.table.get(x8)
                if old is None:
                    self.table[x8] = (typ, d, worker)
                    self.shares[worker] = self.shares.get(worker, 0) + 1
                    good += 1
                    if self.store_fp:
                        self.store_fp.write(rec + worker.encode()[:16].ljust(16, b"\0"))
                    continue
                if old[0] == typ and old[1] == d:
                    dup += 1
                    continue
                k = self.try_solve(self.candidates(old[0], old[1], typ, d))
                if k is not None:
                    found = k
                    self.solved = {"key": "%064x" % k, "workers": [old[2], worker], "time": time.time()}
                    with open("FOUND.txt", "a") as f:
                        f.write(json.dumps(self.solved) + "\n")
                    good += 1
                    break
                # same 64 bits of x, no key: two different points (about records^2 / 2^65 per run), a mirror pair
                # of wild1/wild2, or a bad record that verified (very rare); keep the old one
                P1, P2 = self.point(old[0], old[1]), self.point(typ, d)
                if P1 is not None and P2 is not None and P1.format()[1:] == P2.format()[1:]:
                    self.mirror += 1
                dup += 1
        if bad:
            self.bad[worker] = self.bad.get(worker, 0) + bad
        if self.store_fp:
            self.store_fp.flush()
        return {"good": good, "bad": bad, "dup": dup, "solved": self.solved is not None}

    def stats(self) -> dict:
        per_share = float(1 << self.dp)
        return {
            "range": self.range, "dp": self.dp, "pubkey": self.pubkey_hex, "jumps_hash": self.jumps_hash,
            "records": len(self.table), "record_bytes": self.rec, "mirror_pairs": self.mirror,
            "uptime_s": int(time.time() - self.t0),
            "expected_records": int(1.15 * 2 ** (self.range / 2) / per_share),
            "progress": len(self.table) / (1.15 * 2 ** (self.range / 2) / per_share),
            "workers": {w: {"shares": s, "work_log2": int(s * per_share).bit_length() - 1 if s else 0,
                            "bad": self.bad.get(w, 0)} for w, s in self.shares.items()},
            "solved": self.solved,
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--port", type=int, default=8800)
    ap.add_argument("--store", default="pool_records.bin")
    args = ap.parse_args()
    job = json.load(open(args.job))
    pool = Pool(job, args.store)

    async def h_job(_req):
        return web.json_response({k: job[k] for k in ("range", "start", "pubkey", "dp", "jumps_hash")})

    async def h_submit(req):
        worker = req.headers.get("X-Worker", "anon")[:16]
        if req.headers.get("X-Jumps-Hash", "").lower() != pool.jumps_hash:
            return web.json_response({"error": "jump tables differ from the pool's"}, status=400)
        if int(req.headers.get("X-Range", "0")) != pool.range:
            return web.json_response({"error": "range differs"}, status=400)
        blob = await req.read()
        res = pool.submit(worker, blob)
        return web.json_response(res)

    async def h_stats(_req):
        return web.json_response(pool.stats())

    app = web.Application(client_max_size=64 * 1024 * 1024)
    app.add_routes([web.get("/job", h_job), web.post("/submit", h_submit), web.get("/stats", h_stats)])
    print(f"pool server: range {pool.range} dp {pool.dp} records {len(pool.table)} port {args.port}")
    web.run_app(app, port=args.port, print=None)


if __name__ == "__main__":
    main()
