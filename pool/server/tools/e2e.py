#!/usr/bin/env python3
"""End-to-end check of bumblebeam-pool without a real Beam node.

Plays the node: a plain-TCP stratum server that answers the pool's login, sends a job built from a
real mainnet header (vectors/mainnet_headers.json) and accepts the solution it gets back.
Plays a miner: logs in to the pool, waits for the job and submits the header's real solution.
Expects: share accepted by the pool, block solution forwarded to the "node", block recorded in the
pool's API with a PPLNS credit.

usage: e2e.py <vectors/mainnet_headers.json> --node-port 18101 --pool 127.0.0.1:13333 --api http://127.0.0.1:18080
"""
import argparse, json, socket, sys, threading, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("vectors")
ap.add_argument("--node-port", type=int, default=18101)
ap.add_argument("--pool", default="127.0.0.1:13333")
ap.add_argument("--api", default="http://127.0.0.1:18080")
ap.add_argument("--wait", type=float, default=20)
a = ap.parse_args()

hdr = next(h for h in json.load(open(a.vectors))["headers"] if h["algo"] == "BeamHashIII" and h["height"] > 4_000_000)
state = {"login": False, "solution": None, "err": None, "node_out": None}

def node_server():
    srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", a.node_port)); srv.listen(1)
    conn, _ = srv.accept()
    f = conn.makefile("rwb", buffering=0)
    state["node_out"] = f
    for raw in f:
        m = json.loads(raw)
        if m.get("method") == "login":
            state["login"] = m.get("api_key")
            f.write((json.dumps({"jsonrpc": "2.0", "id": "login", "method": "result", "code": 0, "description": "Login successful", "nonceprefix": ""}) + "\n").encode())
            f.write((json.dumps({"jsonrpc": "2.0", "id": "7", "method": "job", "input": hdr["input"], "difficulty": hdr["difficulty"], "height": hdr["height"]}) + "\n").encode())
        elif m.get("method") == "solution":
            state["solution"] = m
            ok = m["nonce"] == hdr["nonce"] and m["output"] == hdr["solution"]
            f.write((json.dumps({"jsonrpc": "2.0", "id": m["id"], "method": "result", "code": 1 if ok else 2,
                                 "description": "accepted" if ok else "rejected", "blockhash": "e2e" + "0" * 61}) + "\n").encode())

threading.Thread(target=node_server, daemon=True).start()
time.sleep(1.0)

host, port = a.pool.split(":")
deadline = time.time() + a.wait
while time.time() < deadline:
    try:
        s = socket.create_connection((host, int(port)), timeout=5); break
    except OSError:
        time.sleep(0.5)
else:
    sys.exit("pool stratum not reachable")
f = s.makefile("rwb", buffering=0)
addr = "a" * 120  # offline-looking address
jobs = []
def expect_result(want_id):
    """Read until the result for want_id; job messages that arrive meanwhile are kept."""
    while True:
        m = json.loads(f.readline())
        if m.get("method") == "job":
            jobs.append(m); continue
        if m.get("method") == "result" and m.get("id") == want_id:
            return m
        print("unexpected:", m)
f.write((json.dumps({"jsonrpc": "2.0", "id": "login", "method": "login", "api_key": f"{addr}.e2e"}) + "\n").encode())
res = expect_result("login"); print("login:", res["code"], res["description"][:40], "prefix:", repr(res.get("nonceprefix")))
assert res["code"] == 0
s.settimeout(a.wait)
while not jobs:
    m = json.loads(f.readline())
    if m.get("method") == "job": jobs.append(m)
job = jobs.pop(0); print("job:", job["id"], "height", job["height"], "diff", job["difficulty"])
assert job["input"] == hdr["input"]
f.write((json.dumps({"jsonrpc": "2.0", "id": job["id"], "method": "solution", "nonce": hdr["nonce"], "output": hdr["solution"]}) + "\n").encode())
res = expect_result(job["id"]); print("share:", res["code"], res["description"])
assert res["code"] == 1, res
# a duplicate must be rejected with a reason
f.write((json.dumps({"jsonrpc": "2.0", "id": job["id"], "method": "solution", "nonce": hdr["nonce"], "output": hdr["solution"]}) + "\n").encode())
res = expect_result(job["id"]); print("dup:", res["code"], res["description"]); assert res["code"] == 2 and "duplicate" in res["description"]
# a corrupted solution must be rejected with the oracle's reason
bad = hdr["solution"][:-2] + ("00" if hdr["solution"][-2:] != "00" else "01")
f.write((json.dumps({"jsonrpc": "2.0", "id": job["id"], "method": "solution", "nonce": hdr["nonce"], "output": bad}) + "\n").encode())
res = expect_result(job["id"]); print("bad:", res["code"], res["description"]); assert res["code"] == 2 and "collision" in res["description"]
# an over-long line must close the connection, not be buffered
s2 = socket.create_connection((host, int(port)), timeout=5)
s2.sendall(b"{" + b"a" * 20000)
try:
    s2.settimeout(5); closed = s2.recv(10) == b""
except OSError:
    closed = True
print("long line closes connection:", closed); assert closed; s2.close()

t = time.time() + 10
while time.time() < t and not state["solution"]:
    time.sleep(0.2)
assert state["solution"], "pool did not forward the block to the node"
print("node got block solution for job", state["solution"]["id"])

# the chain moves on: the node issues a template for the next height; a share for the old one is stale
nxt = {"jsonrpc": "2.0", "id": "8", "method": "job", "input": ("0" if hdr["input"][0] != "0" else "1") + hdr["input"][1:], "difficulty": hdr["difficulty"], "height": hdr["height"] + 1}
state["node_out"].write((json.dumps(nxt) + "\n").encode())
while not jobs:
    m = json.loads(f.readline())
    if m.get("method") == "job": jobs.append(m)
job2 = jobs.pop(0); print("job2:", job2["id"], "height", job2["height"])
assert job2["height"] == hdr["height"] + 1
f.write((json.dumps({"jsonrpc": "2.0", "id": job["id"], "method": "solution", "nonce": hdr["nonce"][:-2] + "ff", "output": hdr["solution"]}) + "\n").encode())
res = expect_result(job["id"]); print("old-height share:", res["code"], res["description"]); assert res["code"] == 3

time.sleep(2)
blocks = json.load(urllib.request.urlopen(a.api + "/api/blocks"))["blocks"]
print("api blocks:", [(b["height"], b["status"], b["finder"], b["reward"]) for b in blocks[:2]])
assert blocks and blocks[0]["height"] == hdr["height"] and blocks[0]["reward"] == 2500000000
m = json.load(urllib.request.urlopen(a.api + f"/api/miners/{addr}"))
print("miner immature groth:", m["immature"], "hashrate:", round(m["hashrate"], 1))
assert m["immature"] > 0
stats = json.load(urllib.request.urlopen(a.api + "/api/stats"))
print("stats: miners", stats["minersTotal"], "node height", stats["nodes"][0]["height"], "reward", stats["config"]["blockReward"])
hs = json.load(urllib.request.urlopen(a.api + "/api/blocks/heights"))
print("api block heights:", hs)
assert hs["count"] == 1 and hs["blocks"][0][0] == hdr["height"] and hs["blocks"][0][1] in ("pplns", "solo") and hs["blocks"][0][2] == "pending"
print("stats: blocks pending", stats["blocksPending"])
assert stats["blocksPending"] == 1
print("E2E OK")
