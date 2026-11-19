#!/usr/bin/env python3
"""bbkangaroo pool client: ships new records of <db>.journal to the pool server.

Run next to a worker:  pool_client.py --db puzzle.db --server http://pool:8800 --worker rig1 [--every 60]
Reads range / dp / record length / jumps hash from the DB file header (written by bbkangaroo), remembers the journal
offset in <db>.journal.sent, sends batches of up to 100k records, stops when the server reports the key as found.
Only the Python standard library is needed on the worker.
"""
import argparse, json, os, struct, sys, time, urllib.request

MAGIC = b"BBKDB002"


def read_header(db: str) -> dict | None:
    if not os.path.exists(db):
        return None
    with open(db, "rb") as f:
        h = f.read(256)
    if len(h) < 256 or h[:8] != MAGIC:
        return None
    return {"range": h[8], "dp": h[9], "rec": 8 + h[12], "jumps_hash": "%016x" % struct.unpack_from("<Q", h, 16)[0]}


def post(url: str, data: bytes, headers: dict) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read().decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--server", required=True)
    ap.add_argument("--worker", default=os.uname().nodename[:16])
    ap.add_argument("--every", type=int, default=60)
    ap.add_argument("--batch", type=int, default=100000)
    ap.add_argument("--once", action="store_true")
    a = ap.parse_args()
    journal, sentfile = a.db + ".journal", a.db + ".journal.sent"
    sent = int(open(sentfile).read()) if os.path.exists(sentfile) else 0
    while True:
        hdr = read_header(a.db)
        size = os.path.getsize(journal) if os.path.exists(journal) else 0
        REC = hdr["rec"] if hdr else 0
        if hdr and size - sent >= REC:
            n = min((size - sent) // REC, a.batch)
            with open(journal, "rb") as f:
                f.seek(sent)
                blob = f.read(n * REC)
            try:
                res = post(a.server + "/submit", blob, {"X-Worker": a.worker, "X-Range": str(hdr["range"]),
                                                        "X-Jumps-Hash": hdr["jumps_hash"],
                                                        "Content-Type": "application/octet-stream"})
            except Exception as e:
                print("send failed:", e, file=sys.stderr)
                time.sleep(a.every)
                continue
            sent += len(blob)
            open(sentfile, "w").write(str(sent))
            print(time.strftime("%H:%M:%S"), f"sent {n} records: {res}")
            if res.get("solved"):
                print("the pool has found the key, see the server's FOUND.txt")
                return
            if n == a.batch:
                continue
        if a.once:
            return
        time.sleep(a.every)


if __name__ == "__main__":
    main()
