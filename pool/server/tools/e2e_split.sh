#!/bin/bash
# The end-to-end run with the pool split in two processes (docs/pool-split.md): `run stratum` takes the miner
# (tools/e2e.py's fake node + fake miner), `run app` serves the API the test reads. Then:
#   - the app's health sees the stratum process; the operator's connection list goes through the control interface
#   - the control interface refuses no token and a wrong token; unknown routes (and the old /admin) are JSON 404s
#   - the polled public routes carry Cache-Control, per-miner and health do not
#   - a connection that never logs in is closed at 30 s, a logged-in one that stays silent is not
#   - the stratum TLS certificate is swapped on disk and served without a restart; a mismatched pair is refused
#   - with the stratum process gone, the app answers health 503 (stratum down) instead of hanging or 500s on stats
#   - both stop gracefully
# Needs what tools/e2e.sh needs, plus openssl.
set -u
cd "$(dirname "$0")/.." || exit 1
URL=$(grep -E '^url_file' pool.test.toml | sed -E 's/.*= *"([^"]+)".*/\1/')
DB=$(cat "$URL")
psql "$DB" -q -c "DROP TABLE IF EXISTS shares, blocks, credits, miners, payments, share_events, hashrate_samples, meta, coinbase_pairs, chain_headers, benchmarks, miner_sessions, block_submissions CASCADE;" 2>&1 | grep -v NOTICE
TMP=$(mktemp -d -t pool-split.XXXXXX)
TOKEN=e2e-split-token-0123456789abcdef
cert() { openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=$1" -addext "basicConstraints=critical,CA:FALSE" -keyout "$TMP/$1.key" -out "$TMP/$1.crt" 2>/dev/null; }
cert a; cert b
cp "$TMP/a.crt" "$TMP/pool.crt"; cp "$TMP/a.key" "$TMP/pool.key"
CFG="$TMP/pool.toml"
python3 - "$CFG" "$TMP" "$TOKEN" "$(pwd)/$URL" <<'EOF'
import sys, re
cfg, tmp, token, url = sys.argv[1:]
s = open('pool.test.toml').read()
s = re.sub(r'url_file *= *"[^"]+"', f'url_file = "{url}"', s, count=1)
s = s.replace('[stratum]\n', f'[stratum]\npplns_tls_port = 13443\ntls_cert = "{tmp}/pool.crt"\ntls_key = "{tmp}/pool.key"\n', 1)
s += f'\n[admin]\ntoken = "{token}"\n\n[control]\nbind = "127.0.0.1:18081"\nurl = "http://127.0.0.1:18081"\n'
open(cfg, 'w').write(s)
EOF
pkill -f "bumblebeam-pool .*pool.test.toml" 2>/dev/null; pkill -f "bumblebeam-pool $TMP" 2>/dev/null
BB_TLS_RELOAD_SECS=1 RUST_LOG=info ./target/release/bumblebeam-pool "$CFG" run stratum > /tmp/pool-e2e-stratum.log 2>&1 & ST=$!
sleep 1
RUST_LOG=info ./target/release/bumblebeam-pool "$CFG" run app > /tmp/pool-e2e-app.log 2>&1 & AP=$!
sleep 2
rc=0
ok() { echo "$1: ok"; }
bad() { echo "FAILED: $1"; rc=1; }
python3 tools/e2e.py ../../vectors/mainnet_headers.json || rc=1
echo "--- split checks"
sleep 3   # the app reads the node view every 2 s
H=$(curl -s -o /tmp/health.json -w '%{http_code}' http://127.0.0.1:18080/api/health)
python3 -c "import json; h=json.load(open('/tmp/health.json')); assert h['role']=='app' and h['stratum']=='up' and h['node'], h" && ok "app health sees the stratum process ($H)" || bad "app health: $(cat /tmp/health.json)"
C=$(curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18080/api/admin/connections)
python3 -c "import json,sys; v=json.loads(sys.argv[1]); assert 'live' in v, v" "$C" && ok "admin connections through the control interface" || bad "admin connections: $C"
for p in /api/nonexistent /admin; do
  code=$(curl -s -o /tmp/nf.json -w '%{http_code}' "http://127.0.0.1:18080$p")
  [ "$code" = 404 ] && grep -q '"error"' /tmp/nf.json && ok "$p is a JSON 404" || bad "$p answered $code $(head -c 80 /tmp/nf.json)"
done
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18081/ctl/live)" = 401 ] && ok "control interface refuses no token" || bad "control without token"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer e2e-split-token-0123456789abcdeX' http://127.0.0.1:18081/ctl/live)" = 401 ] && ok "control interface refuses a wrong token" || bad "control with a wrong token"
cc() { curl -s -o /dev/null -D - "http://127.0.0.1:18080$1" | tr -d '\r' | grep -i '^cache-control:' | cut -d' ' -f2-; }
[ "$(cc /api/stats)" = "public, max-age=10" ] && ok "stats: Cache-Control public 10 s" || bad "stats Cache-Control: $(cc /api/stats)"
[ "$(cc '/api/blocks/heights')" = "public, max-age=30" ] && ok "block heights: 30 s" || bad "heights Cache-Control: $(cc /api/blocks/heights)"
[ -z "$(cc /api/health)" ] && ok "health is not cached" || bad "health Cache-Control: $(cc /api/health)"
python3 - <<'EOF' && ok "login deadline (30 s), a silent logged-in miner stays" || bad "login deadline"
import socket, json, time
a = socket.create_connection(("127.0.0.1", 13333)); a.settimeout(1)
a.sendall((json.dumps({"jsonrpc": "2.0", "id": "login", "method": "login", "api_key": "3bf" + "1e74d9e1b45c1bbfdd7b1e73cbb34a24ac3c99fa895a2b2596576977ec".ljust(64, "0") + ".silent"}) + "\n").encode())
b = socket.create_connection(("127.0.0.1", 13333)); b.settimeout(1)
t = time.time(); closed = None
while time.time() - t < 36:
    if closed is None and int(time.time() - t) % 10 == 0:
        try: b.sendall(b"\n")
        except Exception: pass
    try:
        if b.recv(100) == b"" and closed is None: closed = time.time() - t
    except socket.timeout: pass
    except Exception:
        if closed is None: closed = time.time() - t
    try: a.recv(4096)
    except socket.timeout: pass
alive = True
try:
    a.settimeout(2)
    if a.recv(100) == b"": alive = False
except socket.timeout: pass
except Exception: alive = False
assert closed is not None and 29 <= closed <= 33, closed
assert alive
EOF
fp() { echo | openssl s_client -connect 127.0.0.1:13443 2>/dev/null | openssl x509 -noout -subject 2>/dev/null; }
echo "$(fp)" | grep -q "CN *= *a" && ok "TLS serves certificate a" || bad "TLS before the swap: $(fp)"
cp "$TMP/b.key" "$TMP/pool.key"; cp "$TMP/b.crt" "$TMP/pool.crt"; sleep 3
echo "$(fp)" | grep -q "CN *= *b" && ok "TLS certificate swapped on disk is served without a restart" || bad "TLS after the swap: $(fp)"
cp "$TMP/a.key" "$TMP/pool.key"; sleep 3   # a key that does not match the certificate
echo "$(fp)" | grep -q "CN *= *b" && grep -q "do not match" /tmp/pool-e2e-stratum.log && ok "a mismatched pair is refused, b stays" || bad "TLS mismatched pair: $(fp)"
kill -TERM $ST; wait $ST; s=$?
sleep 3
code=$(curl -s -o /tmp/health.json -w '%{http_code}' http://127.0.0.1:18080/api/health)
[ "$code" = 503 ] && grep -q '"stratum":"down"' /tmp/health.json && ok "stratum gone: health 503, stratum down" || bad "health with the stratum gone: $code $(cat /tmp/health.json)"
code=$(curl -s -o /tmp/stats.json -w '%{http_code}' -m 10 'http://127.0.0.1:18080/api/stats?range=6h')
[ "$code" = 200 ] && grep -q '"connectedWorkers":null' /tmp/stats.json && ok "stratum gone: stats still answer, connectedWorkers null" || bad "stats with the stratum gone: $code"
kill -TERM $AP; wait $AP; a=$?
[ $a = 0 ] && [ $s = 0 ] && ok "both stopped gracefully" || bad "stop codes app=$a stratum=$s"
grep -q "shutdown complete" /tmp/pool-e2e-stratum.log && grep -q "shutdown complete" /tmp/pool-e2e-app.log || bad "no shutdown line"
rm -rf "$TMP"
echo "e2e split exit: $rc"; exit $rc
