#!/bin/bash
# Full end-to-end run on a test database: resets the schema, starts the pool with pool.test.toml,
# runs tools/e2e.py (fake node + fake miner), then exercises the admin commands on the block it
# credited. Needs: a built release binary, PostgreSQL with a `bumblebeam` role, the url of a
# throwaway database in database.test.url next to this file's config.
set -u
cd "$(dirname "$0")/.." || exit 1
URL=$(grep -E '^url_file' pool.test.toml | sed -E 's/.*= *"([^"]+)".*/\1/')
DB=$(cat "$URL")
psql "$DB" -q -c "DROP TABLE IF EXISTS shares, blocks, credits, miners, payments, share_events, hashrate_samples, meta CASCADE;" 2>&1 | grep -v NOTICE
pkill -f 'bumblebeam-pool pool.test.toml' 2>/dev/null
RUST_LOG=info nohup ./target/release/bumblebeam-pool pool.test.toml > /tmp/pool-e2e.log 2>&1 &
sleep 2
python3 tools/e2e.py ../../vectors/mainnet_headers.json; rc=$?
echo "--- admin"
./target/release/bumblebeam-pool pool.test.toml admin list 2>/dev/null | head -5
H=$(psql "$DB" -tAc "SELECT height FROM blocks LIMIT 1")
./target/release/bumblebeam-pool pool.test.toml admin block "$H" confirm 2>&1 | grep -q "needs --force" && echo "confirm of a pending block refused without --force: ok" || { echo "PENDING CONFIRM NOT REFUSED"; rc=1; }
./target/release/bumblebeam-pool pool.test.toml admin block "$H" confirm --force 2>/dev/null
BAL=$(psql "$DB" -tAc "SELECT balance FROM miners LIMIT 1")
echo "miner balance after operator confirm --force: $BAL"
[ "$BAL" = "2487500000" ] || { echo "ADMIN CONFIRM FAILED"; rc=1; }
./target/release/bumblebeam-pool pool.test.toml admin block "$H" confirm --force 2>&1 | grep -q "not unverified" && echo "second confirm refused: ok" || { echo "SECOND CONFIRM NOT REFUSED"; rc=1; }
# a payment in review cannot be refunded without a wallet to ask, unless forced
psql "$DB" -q -c "INSERT INTO payments (ts, miner_id, amount, fee, debit, tx_id, status, created_at) SELECT 1, id, 100, 1, 101, 'deadbeefdeadbeefdeadbeefdeadbeef', 'review', 1 FROM miners LIMIT 1"
./target/release/bumblebeam-pool pool.test.toml admin payment deadbeefdeadbeefdeadbeefdeadbeef refund 2>&1 | grep -q "no wallet configured" && echo "refund without wallet refused: ok" || { echo "REFUND NOT REFUSED"; rc=1; }
./target/release/bumblebeam-pool pool.test.toml admin payment deadbeefdeadbeefdeadbeefdeadbeef refund --force 2>&1 | grep -q "debit returned" && echo "forced refund: ok" || { echo "FORCED REFUND FAILED"; rc=1; }
BAL2=$(psql "$DB" -tAc "SELECT balance FROM miners LIMIT 1"); [ "$BAL2" = "2487500101" ] && echo "refund credited debit: ok" || { echo "REFUND AMOUNT WRONG: $BAL2"; rc=1; }
# a payment the wallet once accepted (accepted_at set) must not be refunded without --force even when old
psql "$DB" -q -c "INSERT INTO payments (ts, miner_id, amount, fee, debit, tx_id, status, created_at, accepted_at) SELECT 1, id, 100, 1, 101, 'cafebabecafebabecafebabecafebabe', 'review', 1, 2 FROM miners LIMIT 1"
./target/release/bumblebeam-pool pool.test.toml admin payment cafebabecafebabecafebabecafebabe refund 2>&1 | grep -qE "accepted by the wallet once|no wallet configured" && echo "refund of an accepted payment refused: ok" || { echo "ACCEPTED REFUND NOT REFUSED"; rc=1; }
# --force is recognised in any position
./target/release/bumblebeam-pool pool.test.toml admin --force payment cafebabecafebabecafebabecafebabe refund 2>&1 | grep -q "debit returned" && echo "force in the middle: ok" || { echo "FORCE POSITION FAILED"; rc=1; }
./target/release/bumblebeam-pool pool.test.toml admin list 2>&1 | grep -q "not proven" && echo "list shows unproven txid: ok" || { echo "LIST TXID LINE MISSING"; rc=1; }
sleep 1; pkill -f 'bumblebeam-pool pool.test.toml'
echo "e2e exit: $rc"; exit $rc
