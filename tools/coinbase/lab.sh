#!/bin/bash
# A private FakePoW chain with the whole coinbase-payout stack on one machine, for testing:
#
#   patched beam-node (stratum, owner = mining wallet, --mine_online_foreign)
#       ^ finalization                     ^ stratum
#   bb-finalizer (mining wallet seed) --- bumblebeam-pool (coinbase link) <-- bumblebeam-miner (cb:... account)
#                                              ^ upload
#                                         bb-coinbase (miner wallet's exported keys)
#
# Blocks come every few seconds, coinbase matures after 3, the pool confirms after 5. At the end the miner's
# real beam-wallet is asked what it sees. Everything lives under $LAB; `lab.sh down` stops it all.
#
#   lab.sh up      start everything and mine until the first coinbase payments are completed
#   lab.sh status  what the pool and the finalizer say
#   lab.sh wallet  the miner wallet's view (info + utxo) through the lab node
#   lab.sh down    stop the lab (data stays)
set -u
LAB=${LAB:-$HOME/bumblebeam-lab}
BEAM_BUILD=${BEAM_BUILD:-$HOME/git/beam-cb-build}
REPO=${REPO:-$(cd "$(dirname "$0")/../.." && pwd)}
DBURL_FILE=${DBURL_FILE:-$REPO/pool/server/database.test.url}
NODE=$BEAM_BUILD/beam/beam-node
WALLET=$BEAM_BUILD/wallet/cli/beam-wallet
FIN=$REPO/tools/coinbase/bb-finalizer
CBTOOL=$REPO/tools/coinbase/bb-coinbase
POOL=$REPO/pool/server/target/release/bumblebeam-pool
MINER=$REPO/miner/target/release/bumblebeam-miner
PASS=lab
# the chain: every fork from the start (fees in the coinbase), 3-second blocks from difficulty 2, coinbase matures after 3
RULES="--consensus=FakePoW --TreasuryChecksum=0 --Fork1=1 --Fork2=1 --Fork3=1 --Fork4=1 --Fork5=1 --Fork6=1 --Maturity.Coinbase=3 --DA.Target_ms=3000 --DA.Difficulty0=16777216"
NODE_PORT=19000; MINER_NODE_PORT=19010; STRATUM_PORT=19101; LINK_PORT=13482; HTTP_PORT=19081; PPLNS_PORT=14335; SOLO_PORT=14336
API=http://127.0.0.1:$HTTP_PORT

wallet() { # <wallet dir> <args...>
  local w=$1; shift
  "$WALLET" "$@" --wallet_path "$w/wallet.db" --pass "$PASS" --log_level=error --file_log_level=error $RULES 2>/dev/null
}

seed_phrase() { # prints 12 words separated by ';'
  "$WALLET" generate_phrase 2>/dev/null | grep ';' | tr -d '[:space:]'
}

mk_wallet() { # <dir>
  mkdir -p "$1"
  [ -f "$1/seed" ] || { seed_phrase > "$1/seed"; chmod 600 "$1/seed"; }
  # `init` would generate a new seed and ignore ours; `restore` takes the phrase
  [ -f "$1/wallet.db" ] || wallet "$1" restore --seed_phrase "$(cat "$1/seed")" >/dev/null
  wallet "$1" export_owner_key | sed -n 's/.*Owner Viewer key: *//p' | tr -d '[:space:]' > "$1/owner.key"
  wallet "$1" export_miner_key --subkey=1 | sed -n 's/.*Secret Subkey 1: *//p' | tr -d '[:space:]' > "$1/miner.key"
  [ -s "$1/owner.key" ] && [ -s "$1/miner.key" ] || { echo "key export failed for $1"; exit 1; }
}

up() {
  for b in "$NODE" "$WALLET" "$FIN" "$CBTOOL" "$POOL" "$MINER"; do [ -x "$b" ] || { echo "missing $b"; exit 1; }; done
  mkdir -p "$LAB/node/secrets" "$LAB/pool" "$LAB/logs"
  echo "== wallets"
  mk_wallet "$LAB/mining-wallet"   # the pool's: node owner, gets the pool's share of each block
  mk_wallet "$LAB/miner-wallet"    # a miner's: its pairs end up here
  echo "mining wallet: $("$CBTOOL" keyinfo --owner_key "$(cat "$LAB/mining-wallet/owner.key")" --pass "$PASS" $RULES)"

  echo "== node"
  printf "%s" "lab-stratum-key" > "$LAB/node/secrets/stratum.api.keys"
  (cd "$LAB/node" && exec nohup "$NODE" --port $NODE_PORT --storage "$LAB/node/node.db" --log_level=${NODE_LOG:-info} --file_log_level=${NODE_LOG:-info} \
    --stratum_port $STRATUM_PORT --stratum_secrets_path "$LAB/node/secrets" --stratum_use_tls 0 --nonceprefix_digits 0 \
    --mining_threads 0 --pow_solve_time 1000 --mine_online 1 --mine_online_foreign 1 --mine_online_reserve 65536 \
    --owner_key "$(cat "$LAB/mining-wallet/owner.key")" --miner_key "$(cat "$LAB/mining-wallet/miner.key")" --pass "$PASS" \
    $RULES > "$LAB/logs/node.out" 2>&1) &
  echo $! > "$LAB/node.pid"
  for i in $(seq 1 30); do (echo > /dev/tcp/127.0.0.1/$STRATUM_PORT) 2>/dev/null && break; sleep 1; done
  (echo > /dev/tcp/127.0.0.1/$STRATUM_PORT) 2>/dev/null || { echo "node stratum did not come up"; tail -20 "$LAB/logs/node.out"; exit 1; }

  # The miner's own node, stock settings: it validates every block the pool mines (consensus) and, holding
  # the miner wallet's owner key, serves that wallet its UTXO events - as a miner's node does today.
  echo "== miner's node"
  mkdir -p "$LAB/miner-node"
  (cd "$LAB/miner-node" && exec nohup "$NODE" --port $MINER_NODE_PORT --storage "$LAB/miner-node/node.db" --peer 127.0.0.1:$NODE_PORT \
    --owner_key "$(cat "$LAB/miner-wallet/owner.key")" --pass "$PASS" --log_level=info --file_log_level=info \
    $RULES > "$LAB/logs/miner-node.out" 2>&1) &
  echo $! > "$LAB/miner-node.pid"

  echo "== finalizer"
  (cd "$LAB" && exec nohup "$FIN" --node 127.0.0.1:$NODE_PORT --pool 127.0.0.1:$LINK_PORT --seed_file "$LAB/mining-wallet/seed" --subkey 1 \
    --log_level=info $RULES > "$LAB/logs/finalizer.out" 2>&1) &
  echo $! > "$LAB/finalizer.pid"

  echo "== pool"
  cat > "$LAB/pool/pool.toml" <<EOF
[node]
stratum_addr = "127.0.0.1:$STRATUM_PORT"
api_key = "lab-stratum-key"
tls = false
sync_lag_blocks = 0
[stratum]
pplns_port = $PPLNS_PORT
solo_port = $SOLO_PORT
nonce_prefix_bytes = 2
[pool]
name = "BumbleBeam lab"
fee_percent = 0.5
solo_fee_percent = 0.5
min_payout_groth = 100000000
payout_interval_secs = 7200
pplns_window = 2.0
maturity = 5
unsafe_test_maturity = true
verify_blocks_with_wallet = false
[vardiff]
start = 1.0
min = 1.0
max = 1000000.0
target_secs = 10.0
[coinbase]
enabled = true
link_bind = "127.0.0.1:$LINK_PORT"
[http]
bind = "127.0.0.1:$HTTP_PORT"
web_dir = "$REPO/pool/web"
[database]
url_file = "$DBURL_FILE"
EOF
  psql "$(cat "$DBURL_FILE")" -q -c "DROP TABLE IF EXISTS shares, blocks, credits, miners, payments, share_events, hashrate_samples, meta, coinbase_pairs, chain_headers CASCADE;" 2>&1 | grep -v NOTICE
  (cd "$LAB/pool" && RUST_LOG=info exec nohup "$POOL" "$LAB/pool/pool.toml" > "$LAB/logs/pool.out" 2>&1) &
  echo $! > "$LAB/pool.pid"
  for i in $(seq 1 30); do curl -sf "$API/api/health" >/dev/null 2>&1 && break; sleep 1; done
  curl -sf "$API/api/health" || { echo "pool did not come up"; tail -20 "$LAB/logs/pool.out"; exit 1; }
  echo

  echo "== miner's stock (bb-coinbase)"
  CFG="$LAB/miner-wallet/bb-coinbase.json"
  [ -f "$CFG" ] || "$CBTOOL" init --config "$CFG" --miner_key "$(cat "$LAB/miner-wallet/miner.key")" --owner_key "$(cat "$LAB/miner-wallet/owner.key")" --subkey 1 --pass "$PASS" $RULES
  ACCOUNT=$("$CBTOOL" identity --config "$CFG" --pass "$PASS" $RULES)
  echo "account: $ACCOUNT"
  for i in $(seq 1 20); do curl -s "$API/api/coinbase" | grep -q '"connected":true' && break; sleep 1; done
  for i in 1 2 3 4 5; do
    "$CBTOOL" top-up --config "$CFG" --pass "$PASS" --pool "$API" --per_step 3 $RULES && break
    echo "top-up attempt $i failed, retrying"; sleep 5
  done

  echo "== miner"
  (cd "$LAB" && BB_THREADS=${BB_THREADS:-8} exec nohup "$MINER" mine --pool 127.0.0.1:$PPLNS_PORT --user "$ACCOUNT.lab" --tls 0 > "$LAB/logs/miner.out" 2>&1) &
  echo $! > "$LAB/miner.pid"

  echo "== mining; waiting for coinbase payments to complete (up to 15 min)"
  for i in $(seq 1 180); do
    sleep 5
    M=$(curl -s "$API/api/miners/$ACCOUNT")
    DONE=$(echo "$M" | python3 -c "import sys,json; m=json.load(sys.stdin); print(sum(1 for p in m['payments'] if p['status']=='completed'))" 2>/dev/null || echo 0)
    if [ $((i % 6)) -eq 0 ]; then
      echo "  $(curl -s "$API/api/stats" | python3 -c "import sys,json; s=json.load(sys.stdin); print('height', s['nodes'][0]['height'], 'pool sol/s', round(s['hashrate'],2))" 2>/dev/null)  $(echo "$M" | python3 -c "import sys,json; m=json.load(sys.stdin); c=m['coinbase']; print('stock', c['stockPairs'], 'mined', c['minedPairs'], 'in', c['blocks'], 'blocks; payments', len(m['payments']), 'completed', sum(1 for p in m['payments'] if p['status']=='completed'), 'balance', m['balance'], 'paid', m['paid'])" 2>/dev/null)"
    fi
    [ "${DONE:-0}" -ge 2 ] && break
  done
  status
  echo "== topping up the stock again (pairs were spent)"
  "$CBTOOL" top-up --config "$CFG" --pass "$PASS" --pool "$API" --per_step 3 $RULES
  "$CBTOOL" status --config "$CFG" --pass "$PASS" --pool "$API" $RULES
}

status() {
  echo "== pool: $(curl -s "$API/api/stats" | python3 -c "import sys,json; s=json.load(sys.stdin); print('height', s['nodes'][0]['height'], 'miners', s['minersTotal'], 'hashrate', round(s['hashrate'],2))")"
  curl -s "$API/api/coinbase" | python3 -c "import sys,json; c=json.load(sys.stdin); print('   coinbase: accounts', c['accounts'], 'stock', c['stockPairs'], 'mined pairs', c['minedPairs'], 'finalizer', c['finalizer'])"
  curl -s "$API/api/blocks" | python3 -c "
import sys,json; b=json.load(sys.stdin)['blocks']
print('   blocks:', len(b), 'confirmed', sum(1 for x in b if x['status']=='confirmed'), 'pending', sum(1 for x in b if x['status']=='pending'), 'orphaned', sum(1 for x in b if x['status']=='orphaned'), 'unverified', sum(1 for x in b if x['status']=='unverified'))"
  curl -s "$API/api/payments" | python3 -c "import sys,json; p=json.load(sys.stdin)['payments']; print('   payment runs:', len(p), 'completed', sum(1 for x in p if x['status']=='completed'))"
  echo "== finalizer (last lines)"; grep -E "coinbase for|paid|reorg|dropped|WARNING|ERROR" "$LAB/logs/finalizer.out" | tail -5 | cut -c1-160
  echo "== pool log (coinbase)"; grep -E "coinbase|block verdict|BLOCK FOUND|settled" "$LAB/logs/pool.out" | tail -6 | cut -c1-200
}

sync_wallet() { # <wallet dir> <node port>: the CLI wallet syncs while it listens
  timeout ${SYNC_SECS:-60} "$WALLET" listen --wallet_path "$1/wallet.db" --pass "$PASS" -n 127.0.0.1:$2 --log_level=info --file_log_level=error $RULES > "$LAB/logs/$(basename "$1")-listen.out" 2>&1
}

wallet_view() {
  echo "== miner wallet, through the miner's own node (syncing ${SYNC_SECS:-60} s)"
  sync_wallet "$LAB/miner-wallet" $MINER_NODE_PORT
  wallet "$LAB/miner-wallet" info | grep -E "Available|Maturing|coinbase|Current height|Total unspent" | head -8
  echo "-- coins (first 12)"
  wallet "$LAB/miner-wallet" info --utxo_list | grep -E "^\s*\|" | head -14
  echo "== mining wallet, the pool's share (syncing)"
  sync_wallet "$LAB/mining-wallet" $NODE_PORT
  wallet "$LAB/mining-wallet" info | grep -E "Available|Maturing|coinbase|Current height|Total unspent" | head -8
}

down() {
  for p in miner pool finalizer miner-node node; do
    [ -f "$LAB/$p.pid" ] && { kill "$(cat "$LAB/$p.pid")" 2>/dev/null; rm -f "$LAB/$p.pid"; }
  done
  echo "lab stopped"
}

reset() { # a new chain; the wallets and their keys stay
  down; sleep 1
  rm -rf "$LAB/node/node.db" "$LAB/node/node.db-journal" "$LAB/node/node-utxo-image.bin" "$LAB/node/logs" "$LAB/logs" "$LAB/miner-node"
  for w in mining-wallet miner-wallet; do rm -f "$LAB/$w/wallet.db" "$LAB/$w/wallet.db-journal" "$LAB/$w/owner.key" "$LAB/$w/miner.key" "$LAB/$w/bb-coinbase.json"; done
  echo "lab chain and wallet databases removed (seeds kept)"
}

case "${1:-}" in
  up) up ;;
  status) status ;;
  wallet) wallet_view ;;
  down) down ;;
  reset) reset ;;
  *) echo "usage: lab.sh up|status|wallet|down|reset"; exit 1 ;;
esac
