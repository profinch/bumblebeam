#!/bin/bash
# The end-to-end run with the pool split in two processes (docs/pool-split.md): `run stratum` takes the miner
# (tools/e2e.py's fake node + fake miner), `run app` serves the API the test reads. Then: the app's health sees
# the stratum process, the operator's connection list goes through the control interface, both stop gracefully.
# Needs what tools/e2e.sh needs.
set -u
cd "$(dirname "$0")/.." || exit 1
URL=$(grep -E '^url_file' pool.test.toml | sed -E 's/.*= *"([^"]+)".*/\1/')
DB=$(cat "$URL")
psql "$DB" -q -c "DROP TABLE IF EXISTS shares, blocks, credits, miners, payments, share_events, hashrate_samples, meta, coinbase_pairs, chain_headers, benchmarks, miner_sessions, block_submissions CASCADE;" 2>&1 | grep -v NOTICE
CFG=$(mktemp -t pool-split.XXXXXX).toml
TOKEN=e2e-split-token-0123456789abcdef
{ cat pool.test.toml; printf '\n[admin]\ntoken = "%s"\n\n[control]\nbind = "127.0.0.1:18081"\nurl = "http://127.0.0.1:18081"\n' "$TOKEN"; } > "$CFG"
cp "$URL" "$(dirname "$CFG")/" 2>/dev/null   # url_file is relative to the config
pkill -f "bumblebeam-pool .*pool.test.toml" 2>/dev/null; pkill -f "bumblebeam-pool $CFG" 2>/dev/null
RUST_LOG=info ./target/release/bumblebeam-pool "$CFG" run stratum > /tmp/pool-e2e-stratum.log 2>&1 & ST=$!
sleep 1
RUST_LOG=info ./target/release/bumblebeam-pool "$CFG" run app > /tmp/pool-e2e-app.log 2>&1 & AP=$!
sleep 2
rc=0
python3 tools/e2e.py ../../vectors/mainnet_headers.json || rc=1
echo "--- split checks"
sleep 3   # the app reads the node view every 2 s
H=$(curl -s -o /tmp/health.json -w '%{http_code}' http://127.0.0.1:18080/api/health)
python3 -c "import json; h=json.load(open('/tmp/health.json')); print('health', $H, h); assert h['role']=='app' and h['stratum']=='up' and h['node'], h" && echo "app health sees the stratum process: ok" || { echo "APP HEALTH WRONG"; rc=1; }
C=$(curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18080/api/admin/connections)
python3 -c "import json,sys; v=json.loads(sys.argv[1]); assert 'live' in v, v" "$C" && echo "admin connections through the control interface: ok" || { echo "ADMIN CONNECTIONS FAILED: $C"; rc=1; }
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/api/nonexistent | grep -q 404 && echo "unknown route is a 404: ok" || { echo "UNKNOWN ROUTE NOT 404"; rc=1; }
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18081/ctl/live | grep -q 401 && echo "control interface refuses without the token: ok" || { echo "CONTROL NOT PROTECTED"; rc=1; }
kill -TERM $AP; wait $AP; a=$?; kill -TERM $ST; wait $ST; s=$?
[ $a = 0 ] && [ $s = 0 ] && echo "both stopped gracefully: ok" || { echo "STOP CODES app=$a stratum=$s"; rc=1; }
grep -q "shutdown complete" /tmp/pool-e2e-stratum.log && grep -q "shutdown complete" /tmp/pool-e2e-app.log || { echo "NO SHUTDOWN LINE"; rc=1; }
rm -f "$CFG"
echo "e2e split exit: $rc"; exit $rc
