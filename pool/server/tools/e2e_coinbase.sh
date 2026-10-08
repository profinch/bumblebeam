#!/bin/bash
# Coinbase payouts end to end on a test database: resets the schema, starts the pool with
# pool.cbtest.toml and runs tools/e2e_coinbase.py (fake node, fake miner, fake bb-finalizer).
# Needs: a built release binary, PostgreSQL, database.test.url next to the config.
set -u
cd "$(dirname "$0")/.." || exit 1
URL=$(grep -E '^url_file' pool.cbtest.toml | sed -E 's/.*= *"([^"]+)".*/\1/')
DB=$(cat "$URL")
psql "$DB" -q -c "DROP TABLE IF EXISTS shares, blocks, credits, miners, payments, share_events, hashrate_samples, meta, coinbase_pairs, chain_headers CASCADE;" 2>&1 | grep -v NOTICE
pkill -f 'bumblebeam-pool pool.cbtest.toml' 2>/dev/null
RUST_LOG=info nohup ./target/release/bumblebeam-pool pool.cbtest.toml > /tmp/pool-e2e-coinbase.log 2>&1 &
sleep 2
python3 tools/e2e_coinbase.py ../../vectors/mainnet_headers.json --db "$DB"; rc=$?
sleep 1; pkill -f 'bumblebeam-pool pool.cbtest.toml'
echo "e2e coinbase exit: $rc"; exit $rc
