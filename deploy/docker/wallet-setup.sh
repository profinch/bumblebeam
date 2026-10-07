#!/bin/bash
# One-time pool wallet setup. Run it yourself, in an interactive ssh session:
#   sudo /data/docker/wallet-setup.sh
#
# Asks for the seed phrase and a wallet password (neither is echoed), restores
# wallet.db, writes wallet.pass, exports the miner key (subkey 1) and the owner
# key and puts them, with the password, into beam-node.cfg, enabling the node's
# stratum for the pool. Seed and keys never reach the screen, the shell history
# or a host process list: everything happens inside a throwaway container.
set -euo pipefail

WALLET_DIR=${WALLET_DIR:-/data/bumblebeam/wallet}
NODE_DIR=${NODE_DIR:-/data/bumblebeam/node}
IMAGE=${IMAGE:-bumblebeam-beam}

[ -e "$WALLET_DIR/wallet.db" ] && { echo "$WALLET_DIR/wallet.db already exists, refusing to overwrite" >&2; exit 1; }
[ -f "$NODE_DIR/beam-node.cfg" ] || { echo "$NODE_DIR/beam-node.cfg not found" >&2; exit 1; }

docker run --rm -i ${DOCKER_TTY:--t} -u 10001:10001 -e HISTFILE=/dev/null \
  -v "$WALLET_DIR":/wallet -v "$NODE_DIR":/node -w /wallet "$IMAGE" bash -c '
set -euo pipefail
umask 077
read -rsp "Seed phrase (w1;w2;...;w12): " SEED; echo
read -rsp "Wallet password: " P1; echo
read -rsp "Repeat password: " P2; echo
[ -n "$P1" ] && [ "$P1" = "$P2" ] || { echo "passwords do not match or are empty" >&2; exit 1; }
unset P2

if ! beam-wallet restore --wallet_path=wallet.db --pass="$P1" --seed_phrase="$SEED" >restore.log 2>&1; then
  unset SEED; grep -E "^E " restore.log >&2 || true; rm -f wallet.db restore.log; exit 1
fi
unset SEED; rm -f restore.log
printf %s "$P1" > wallet.pass

MK=$(beam-wallet export_miner_key --subkey=1 --wallet_path=wallet.db --pass="$P1" 2>/dev/null | sed -n "s/^Secret Subkey 1: //p")
OK=$(beam-wallet export_owner_key --wallet_path=wallet.db --pass="$P1" 2>/dev/null | sed -n "s/^Owner Viewer key: //p")
[ -n "$MK" ] && [ -n "$OK" ] || { echo "key export failed" >&2; exit 1; }

cfg=/node/beam-node.cfg
grep -vE "^#?(stratum_port|stratum_secrets_path|stratum_use_tls|miner_key|owner_key|pass)=" "$cfg" > "$cfg.new"
cat >> "$cfg.new" <<EOF
stratum_port=8101
stratum_secrets_path=/data/secrets
stratum_use_tls=1
miner_key=$MK
owner_key=$OK
pass=$P1
EOF
unset MK OK P1
mv "$cfg.new" "$cfg"
echo "wallet restored; wallet.pass written; miner/owner keys are in beam-node.cfg"
'
echo "next: docker compose -f /data/docker/compose-bumblebeam.yaml up -d --force-recreate beam-node wallet-api"
