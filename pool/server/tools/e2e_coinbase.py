#!/usr/bin/env python3
"""End-to-end check of coinbase payouts in bumblebeam-pool, without Beam binaries.

Plays the node (stratum, as e2e.py does), a miner that logs in with a coinbase account and finds the
block, and bb-finalizer on the coinbase link: it "verifies" uploaded pairs, asks for a coinbase, reports
the block's kernels and the chain's headers. Expects: pairs stored and listed per account, the allocation
to pay what the account is owed, a pending coinbase payment once the kernels are in the chain, and the
block confirmed by the node's chain with the payment completed and the balance settled.

usage: e2e_coinbase.py <vectors/mainnet_headers.json> --db <postgres url> [--node-port 19102 --pool 127.0.0.1:14333 --api http://127.0.0.1:19080 --link 127.0.0.1:13481]
"""
import argparse, json, socket, subprocess, sys, threading, time, urllib.request, urllib.error

ap = argparse.ArgumentParser()
ap.add_argument("vectors")
ap.add_argument("--db", required=True)
ap.add_argument("--node-port", type=int, default=19102)
ap.add_argument("--pool", default="127.0.0.1:14333")
ap.add_argument("--api", default="http://127.0.0.1:19080")
ap.add_argument("--link", default="127.0.0.1:13481")
ap.add_argument("--wait", type=float, default=20)
a = ap.parse_args()

hdr = next(h for h in json.load(open(a.vectors))["headers"] if h["algo"] == "BeamHashIII" and h["height"] > 4_000_000)
H = hdr["height"]
HASH_H = "c0ffee" + "0" * 58
state = {"solution": None, "node_out": None}
UNIT = 1 << 20
ACCOUNT = "cb:" + "ab" * 32 + "01"
KA, KB = "a1" * 32, "b2" * 32

def psql(sql):
    return subprocess.run(["psql", a.db, "-tAc", sql], capture_output=True, text=True).stdout.strip()

def api(path, body=None):
    req = urllib.request.Request(a.api + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"} if body is not None else {})
    try:
        return json.load(urllib.request.urlopen(req, timeout=30)), 200
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}"), e.code

# ---- the node ----
def node_server():
    srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", a.node_port)); srv.listen(1)
    conn, _ = srv.accept()
    f = conn.makefile("rwb", buffering=0)
    state["node_out"] = f
    for raw in f:
        m = json.loads(raw)
        if m.get("method") == "login":
            f.write((json.dumps({"jsonrpc": "2.0", "id": "login", "method": "result", "code": 0, "description": "Login successful", "nonceprefix": ""}) + "\n").encode())
            f.write((json.dumps({"jsonrpc": "2.0", "id": "7", "method": "job", "input": hdr["input"], "difficulty": hdr["difficulty"], "height": H}) + "\n").encode())
        elif m.get("method") == "solution":
            state["solution"] = m
            ok = m["nonce"] == hdr["nonce"] and m["output"] == hdr["solution"]
            f.write((json.dumps({"jsonrpc": "2.0", "id": m["id"], "method": "result", "code": 1 if ok else 2,
                                 "description": "accepted" if ok else "rejected", "blockhash": HASH_H}) + "\n").encode())

threading.Thread(target=node_server, daemon=True).start()
time.sleep(1.0)

def connect(hostport):
    host, port = hostport.split(":")
    deadline = time.time() + a.wait
    while time.time() < deadline:
        try:
            return socket.create_connection((host, int(port)), timeout=5)
        except OSError:
            time.sleep(0.5)
    sys.exit(f"{hostport} not reachable")

# ---- the finalizer ----
fin = connect(a.link); fin.settimeout(30)
ff = fin.makefile("rwb", buffering=0)
def fin_send(obj): ff.write((json.dumps(obj) + "\n").encode())
def fin_read():
    line = ff.readline()
    assert line, "link closed"
    return json.loads(line)

fin_send({"id": 1, "method": "hello", "version": "e2e fake finalizer", "tip": H - 1, "scanned": 0})
r = fin_read(); print("hello:", r)
assert r["ok"] and r["scanned"] == 0 and r["ladder"]["shift"] == 20
info, _ = api("/api/coinbase"); print("coinbase info:", {k: info[k] for k in ("enabled", "ladder", "finalizer")})
assert info["enabled"] and info["finalizer"]["connected"]

# ---- the miner logs in with a coinbase account ----
s = connect(a.pool); s.settimeout(a.wait)
f = s.makefile("rwb", buffering=0)
jobs = []
def expect_result(want_id):
    while True:
        m = json.loads(f.readline())
        if m.get("method") == "job":
            jobs.append(m); continue
        if m.get("method") == "result" and m.get("id") == want_id:
            return m
f.write((json.dumps({"jsonrpc": "2.0", "id": "login", "method": "login", "api_key": f"{ACCOUNT}.e2e"}) + "\n").encode())
res = expect_result("login"); print("login:", res["code"], res["description"][:60])
assert res["code"] == 0 and "coinbase" in res["description"]
while not jobs:
    m = json.loads(f.readline())
    if m.get("method") == "job": jobs.append(m)
job = jobs.pop(0)

# a wrong account is refused
s2 = connect(a.pool); f2 = s2.makefile("rwb", buffering=0)
f2.write((json.dumps({"jsonrpc": "2.0", "id": "login", "method": "login", "api_key": "cb:" + "ab" * 32 + "07.x"}) + "\n").encode())
r2 = json.loads(f2.readline()); print("bad account login:", r2["code"]); assert r2["code"] == -32003; s2.close()

# ---- upload pairs: the pool asks the finalizer to verify ----
def serve_verify(results, ok=True, error=None):
    req = fin_read()
    assert req["method"] == "verify", req
    assert req["account"] == ACCOUNT and req["signature"] == "00ff" and req["domain"], req
    assert not ok or len(req["pairs"]) == len(results), req
    out = {"id": req["id"], "ok": ok, "tip": H - 1}
    if ok: out["results"] = results
    else: out["error"] = error
    fin_send(out)
    return req

def pair_ok(value, kernel, commitment):
    return {"ok": True, "value": value, "kernel": kernel, "commitment": commitment, "size": 249, "minHeight": H - 1, "maxHeight": H - 1 + 43200}

pairs = ["aa" * 249, "bb" * 249, "cc" * 249, "dd" * 249, "ee" * 249]
body = {"account": ACCOUNT.upper(), "ts": int(time.time()), "pairs": pairs, "signature": "00ff"}
t = threading.Thread(target=lambda: serve_verify([
    pair_ok(8 * UNIT, KA, "02" + "11" * 32), pair_ok(UNIT, KB, "02" + "22" * 32),
    {"ok": False, "error": "invalid kernel signature"},
    pair_ok(3 * UNIT, "d4" * 32, "02" + "44" * 32),                        # not a ladder step
    {"ok": True, "value": UNIT, "kernel": "e5" * 32, "commitment": "02" + "55" * 32, "size": 249, "minHeight": H - 1, "maxHeight": H + 100},  # expires too soon
]))
t.start(); up, code = api("/api/coinbase/pairs", body); t.join()
print("upload:", code, up)
assert code == 200 and up["accepted"] == 2 and up["stockPairs"] == 2 and len(up["rejected"]) == 3
errs = {r["index"]: r["error"] for r in up["rejected"]}
assert "signature" in errs[2] and "ladder" in errs[3] and "expires" in errs[4]

# the same pairs again: duplicates
t = threading.Thread(target=lambda: serve_verify([pair_ok(8 * UNIT, KA, "02" + "11" * 32), pair_ok(UNIT, KB, "02" + "22" * 32)]))
t.start(); up2, code = api("/api/coinbase/pairs", {**body, "pairs": pairs[:2]}); t.join()
print("duplicate upload:", code, up2["accepted"], up2["rejected"][0]["error"][:30]); assert code == 200 and up2["accepted"] == 0 and len(up2["rejected"]) == 2

# a bad signature according to the finalizer
t = threading.Thread(target=lambda: serve_verify([], ok=False, error="bad signature for this account and upload"))
t.start(); up3, code = api("/api/coinbase/pairs", {**body, "pairs": ["ff" * 10]}); t.join()
print("bad signature:", code, up3); assert code == 400 and "signature" in up3["error"]

# shape checks need no finalizer
_, code = api("/api/coinbase/pairs", {**body, "account": "cb:zz"}); assert code == 400
_, code = api("/api/coinbase/pairs", {**body, "pairs": ["abc"]}); assert code == 400
_, code = api("/api/coinbase/pairs", {**body, "ts": 1}); assert code == 400

m, _ = api(f"/api/miners/{ACCOUNT}")
print("account:", m["addressType"], m["coinbase"])
assert m["addressType"] == "coinbase" and m["coinbase"]["stockPairs"] == 2 and m["coinbase"]["stockValue"] == 9 * UNIT

# ---- the account is owed a balance from earlier blocks; the node asks for the coinbase of block H ----
psql(f"UPDATE miners SET balance = {9 * UNIT} WHERE address = '{ACCOUNT}'")
total = 2500000000
fin_send({"id": 2, "method": "coinbase", "height": H, "fees": 0, "total": total})
r = fin_read(); print("coinbase:", r["paid"], r["poolValue"], r["offers"], len(r["pairs"]))
assert r["ok"] and r["pairs"] == [pairs[0], pairs[1]] and r["paid"] == 9 * UNIT and r["poolValue"] == total - 9 * UNIT

# owed only what is in stock: with a smaller balance just the small pair fits
psql(f"UPDATE miners SET balance = {2 * UNIT} WHERE address = '{ACCOUNT}'")
fin_send({"id": 3, "method": "coinbase", "height": H, "fees": 0, "total": total})
r = fin_read(); assert r["pairs"] == [pairs[1]] and r["paid"] == UNIT, r
psql(f"UPDATE miners SET balance = {9 * UNIT} WHERE address = '{ACCOUNT}'")
fin_send({"method": "built", "height": H, "pairs": 2, "paid": 9 * UNIT, "poolValue": total - 9 * UNIT, "dropped": [], "note": ""})

# ---- the miner finds block H ----
f.write((json.dumps({"jsonrpc": "2.0", "id": job["id"], "method": "solution", "nonce": hdr["nonce"], "output": hdr["solution"]}) + "\n").encode())
res = expect_result(job["id"]); print("share:", res["code"], res["description"]); assert res["code"] == 1
t0 = time.time() + 10
while time.time() < t0 and not state["solution"]:
    time.sleep(0.2)
assert state["solution"], "pool did not forward the block"
time.sleep(1.5)
blocks, _ = api("/api/blocks"); print("block:", [(b["height"], b["status"], b["hash"][:8]) for b in blocks["blocks"][:1]])
assert blocks["blocks"][0]["height"] == H and blocks["blocks"][0]["status"] == "pending"

# ---- the finalizer sees the block: our two kernels are in it ----
fin_send({"method": "headers", "tip": H, "headers": [{"height": H - 1, "hash": "ee" * 32}, {"height": H, "hash": HASH_H.upper()}]})
fin_send({"method": "mined", "height": H, "hash": HASH_H, "kernels": [KA.upper(), "f0" * 32, KB]})
time.sleep(1.0)
m, _ = api(f"/api/miners/{ACCOUNT}")
print("after mined:", m["coinbase"]["minedPairs"], m["coinbase"]["minedValue"], m["coinbase"]["blocks"], "balance", m["balance"], "paid", m["paid"], m["payments"])
assert m["coinbase"]["minedPairs"] == 2 and m["coinbase"]["minedValue"] == 9 * UNIT and m["coinbase"]["stockPairs"] == 0
assert len(m["payments"]) == 1 and m["payments"][0]["status"] == "pending" and m["payments"][0]["amount"] == 9 * UNIT
assert m["payments"][0]["kernel"].startswith(f"coinbase@{H} ")
assert m["balance"] == 0 and m["paid"] == 9 * UNIT, "the debit must leave the balance when the block is read, not when it confirms"
info, _ = api("/api/coinbase"); assert info["finalizer"]["scanned"] == H and info["minedPairs"] == 2

# ---- the next block, before the first one confirms: the old balance must not be paid again ----
t = threading.Thread(target=lambda: serve_verify([pair_ok(UNIT, "c3" * 32, "02" + "33" * 32), pair_ok(UNIT, "c4" * 32, "02" + "34" * 32)]))
t.start(); up4, code = api("/api/coinbase/pairs", {**body, "pairs": ["c3" * 249, "c4" * 249]}); t.join(); assert code == 200 and up4["accepted"] == 2, (code, up4)
fin_send({"id": 5, "method": "coinbase", "height": H + 1, "fees": 0, "total": total})
r = fin_read(); print("next block's coinbase:", r["paid"], r["offers"])
# owed = balance 0 + this block's PPLNS share (the account has the only share) -> both small pairs fit; the 9 units are not offered again
assert r["paid"] == 2 * UNIT and r["offers"] == [{"amount": 2 * UNIT, "miner": 1}], r
# a pair spent in a block that is not ours (another pool on the same chain, or the miner itself) is just gone
fin_send({"method": "mined", "height": H + 1, "hash": "ab" * 32, "kernels": ["c3" * 32]}); time.sleep(0.8)
m, _ = api(f"/api/miners/{ACCOUNT}"); print("foreign block:", m["coinbase"]["spentElsewhere"], "stock", m["coinbase"]["stockPairs"], "payments", len(m["payments"]), "balance", m["balance"])
assert m["coinbase"]["spentElsewhere"] == 1 and m["coinbase"]["stockPairs"] == 1 and len(m["payments"]) == 1 and m["balance"] == 0
# the finalizer saw a stock pair's kernel in the chain while building: out of the stock too
fin_send({"method": "spent", "height": H + 2, "kernels": ["c4" * 32]}); time.sleep(0.8)
m, _ = api(f"/api/miners/{ACCOUNT}"); assert m["coinbase"]["spentElsewhere"] == 2 and m["coinbase"]["stockPairs"] == 0

# ---- the chain grows past maturity, with our hash at H; the node issues a new template ----
fin_send({"method": "headers", "tip": H + 240, "headers": [{"height": h, "hash": f"{h:064x}" if h != H + 1 else "ab" * 32} for h in range(H + 1, H + 241)]})
state["node_out"].write((json.dumps({"jsonrpc": "2.0", "id": "8", "method": "job", "input": "1" + hdr["input"][1:], "difficulty": hdr["difficulty"], "height": H + 242}) + "\n").encode())
print("waiting for the confirmation cycle (up to 80 s)...")
deadline = time.time() + 80
while time.time() < deadline:
    blocks, _ = api("/api/blocks")
    if blocks["blocks"][0]["status"] != "pending":
        break
    time.sleep(2)
b = blocks["blocks"][0]; print("verdict:", b["status"], b["verifiedBy"])
assert b["status"] == "confirmed" and b["verifiedBy"] == "node"
m, _ = api(f"/api/miners/{ACCOUNT}")
print("settled: balance", m["balance"], "paid", m["paid"], "payment", m["payments"][0]["status"])
assert m["payments"][0]["status"] == "completed"
assert m["paid"] == 9 * UNIT and m["balance"] == 2487500000, m   # the block's credit lands; the 9 units left the balance when the block was read

# ---- a rollback below a block that is already confirmed changes nothing; above it, nothing is pending ----
fin_send({"method": "rollback", "height": H + 300}); time.sleep(0.5)
m, _ = api(f"/api/miners/{ACCOUNT}"); assert m["coinbase"]["minedPairs"] == 2 and m["balance"] == 2487500000
# the payments page lists transactions only, not coinbase payments
pp, _ = api("/api/payments"); assert pp["payments"] == [], pp

print("E2E COINBASE OK")
