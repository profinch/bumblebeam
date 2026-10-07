#!/usr/bin/env python3
"""A stand-in for beam-node's stratum (plain TCP): answers login, serves one real mainnet job
(from vectors/mainnet_headers.json) and logs any solution it receives. For miner tests while the
real node syncs.  usage: fake_node.py <vectors/mainnet_headers.json> [port]"""
import json, socket, sys, threading, time
hdr = next(h for h in json.load(open(sys.argv[1]))["headers"] if h["algo"] == "BeamHashIII" and h["height"] > 4_000_000)
port = int(sys.argv[2]) if len(sys.argv) > 2 else 18101
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind(("127.0.0.1", port)); srv.listen(4)
print("fake node on", port, "job height", hdr["height"], flush=True)
def handle(conn):
    f = conn.makefile("rwb", buffering=0)
    for raw in f:
        m = json.loads(raw)
        if m.get("method") == "login":
            f.write((json.dumps({"jsonrpc": "2.0", "id": "login", "method": "result", "code": 0, "description": "Login successful", "nonceprefix": "ab"}) + "\n").encode())
            f.write((json.dumps({"jsonrpc": "2.0", "id": "1", "method": "job", "input": hdr["input"], "difficulty": hdr["difficulty"], "height": hdr["height"]}) + "\n").encode())
        elif m.get("method") == "solution":
            print("SOLUTION from pool:", m["nonce"], m["output"][:16], flush=True)
            f.write((json.dumps({"jsonrpc": "2.0", "id": m["id"], "method": "result", "code": 1, "description": "accepted", "blockhash": "f" * 64}) + "\n").encode())
while True:
    c, _ = srv.accept(); threading.Thread(target=handle, args=(c,), daemon=True).start()
