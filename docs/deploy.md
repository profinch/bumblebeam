# Deploying the pool

One Linux server runs everything: a Beam node, the pool's wallet behind `wallet-api`, PostgreSQL,
and `bumblebeam-pool`. Tested on Linux Mint 22 / Ubuntu 24.04 with Beam 7.5.14493. The layout
below uses `/opt/bumblebeam` for the repository and binary, `/etc/bumblebeam` for configuration
and secrets, `/var/lib/beam` for the node and wallet, and a system user `beam`; any other layout
works, adjust the paths in the units under [`pool/deploy`](../pool/deploy).

## 1. Packages, Rust, PostgreSQL

```sh
sudo apt install -y git cmake ninja-build build-essential pkg-config libssl-dev unzip curl jq postgresql libpq-dev
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal && . ~/.cargo/env
sudo useradd -r -m -d /var/lib/beam -s /usr/sbin/nologin beam
sudo -u postgres psql -c "CREATE ROLE bumblebeam LOGIN PASSWORD '<strong password>'"
sudo -u postgres createdb -O bumblebeam bumblebeam
sudo install -d -m 750 -o beam -g beam /etc/bumblebeam
echo 'postgres://bumblebeam:<strong password>@127.0.0.1:5432/bumblebeam' | sudo tee /etc/bumblebeam/database.url >/dev/null
sudo chown beam:beam /etc/bumblebeam/database.url && sudo chmod 600 /etc/bumblebeam/database.url
```

## 2. Beam binaries

Releases ship as a zip holding a tar: https://github.com/BeamMW/beam/releases.

```sh
V=7.5.14493; B=https://github.com/BeamMW/beam/releases/download/beam-$V
sudo -u beam mkdir -p /var/lib/beam/node /var/lib/beam/wallet
for p in linux-beam-node linux-beam-wallet-cli linux-wallet-api; do
  curl -sSL -o /tmp/$p.zip $B/$p-$V.zip && unzip -oq /tmp/$p.zip -d /tmp/$p && tar xf /tmp/$p/*.tar -C /tmp/$p
done
sudo install -m 755 /tmp/linux-beam-node/beam-node /var/lib/beam/node/
sudo install -m 755 /tmp/linux-beam-wallet-cli/beam-wallet /tmp/linux-wallet-api/wallet-api /var/lib/beam/wallet/
```

## 3. The wallet (operator only)

The pool's wallet receives the coinbase and pays the miners. Restore or create it yourself; never
hand the seed phrase to a tool. A dedicated wallet for the pool is safer than your main one.

```sh
cd /var/lib/beam/wallet && umask 077
echo '<wallet password>' | sudo -u beam tee wallet.pass >/dev/null && sudo chmod 600 wallet.pass
sudo -u beam ./beam-wallet restore --wallet_path=wallet.db --pass="$(cat wallet.pass)" --seed_phrase="w1;w2;...;w12"
sudo -u beam ./beam-wallet export_miner_key --subkey=1 --pass="$(cat wallet.pass)" --wallet_path=wallet.db   # -> miner key
sudo -u beam ./beam-wallet export_owner_key --pass="$(cat wallet.pass)" --wallet_path=wallet.db               # -> owner key
```

## 4. The node

Stratum needs TLS files and an API key file in one directory:

```sh
sudo -u beam mkdir -p /var/lib/beam/node/secrets && cd /var/lib/beam/node/secrets
sudo -u beam openssl req -x509 -newkey rsa:2048 -nodes -keyout stratum.key -out stratum.crt -subj /CN=beam-node -days 3650
head -c 24 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 32 | sudo -u beam tee stratum.api.keys >/dev/null
sudo chmod 600 stratum.key stratum.api.keys
```

Copy [`pool/deploy/beam-node.cfg`](../pool/deploy/beam-node.cfg) to `/var/lib/beam/node/`, fill
in `miner_key`, `owner_key` and `pass` (the wallet password), `chmod 600`, install
[`beam-node.service`](../pool/deploy/beam-node.service) and start it. Notes:

- `fast_sync=1` downloads headers, then block bodies in packs, then builds the UTXO set:
  about 2.5 hours and 8 GB for mainnet in late 2026. Without it the node fetches every block
  one by one, which takes more than a day. For an archival node that serves history to the
  network set `fast_sync=0` and give it time and disk (the full archive is about 32 GB).
- `mine_online=0`: with the owner wallet connected the node would otherwise wait for it on
  every block template.
- While syncing the node emits a stratum job for every historical block it passes; the pool
  drops those (`sync_lag_blocks`) and miners get no work until the node is at the tip.

## 5. wallet-api

Install [`beam-wallet-api.service`](../pool/deploy/beam-wallet-api.service). It listens on
127.0.0.1:10001 over HTTP; anyone who can reach that port can call `tx_send`, so keep it on
loopback and consider `--use_acl` (put the key in `wallet_api.acl_key`). If the wallet shows
`is_in_sync: false` after a node resync, restart the service.

## 6. The pool

```sh
sudo git clone https://github.com/profinch/bumblebeam /opt/bumblebeam && cd /opt/bumblebeam/pool/server
cargo build --release
sudo install -m 755 target/release/bumblebeam-pool /opt/bumblebeam/bumblebeam-pool
sudo -u beam mkdir -p /etc/bumblebeam/tls && cd /etc/bumblebeam/tls
sudo -u beam openssl req -x509 -newkey rsa:2048 -nodes -keyout pool.key -out pool.crt -subj /CN=bumblebeam -days 3650 -addext "subjectAltName=DNS:<pool host>"
sudo cp /opt/bumblebeam/pool/server/pool.example.toml /etc/bumblebeam/pool.toml   # then edit
```

In `pool.toml`: `node.api_key` is the line from `stratum.api.keys`; `wallet_api.url`
`http://127.0.0.1:10001/api/wallet`; `pool.public_host` the name miners connect to;
`http.web_dir` `/opt/bumblebeam/pool/web`; `database.url_file` `/etc/bumblebeam/database.url`;
`block_check_urls` your own explorer-node first if you run one. Keep `maturity` at 240 or more and
`min_payout_groth` well above the shielded network fee (0.01 BEAM). Install
[`bumblebeam-pool.service`](../pool/deploy/bumblebeam-pool.service) and start it.

Check: `curl -s localhost:8080/api/health` shows `"node": true` once the node is synced and a
template arrived; the web UI is on port 8080; `journalctl -u bumblebeam-pool -f` shows logins and
jobs. The database schema is created and migrated on start; only one pool process may run against
a database.

## 7. Before the first payout

With a little balance in the wallet (0.01 BEAM is enough) run once:

```sh
sudo -u beam /opt/bumblebeam/bumblebeam-pool /etc/bumblebeam/pool.toml admin probe-txid
```

It pays 0.001 BEAM three times to a fresh address of the wallet itself and proves that the wallet
refuses a second `tx_send` with the same transaction id. Only with that proof does the pool resend
interrupted payments automatically; without it they wait for an operator in `review`.

Then run the test suite against a throwaway database (`pool/server/tools/e2e.sh`, see its header)
and a real miner against the TLS port: MXBM, lolMiner and GMiner all default to TLS for Beam.

## 8. Network and firewall

Open to the world: 10000/tcp (node p2p, so the node is a full peer), 3333, 3334, 3443, 3444
(stratum), 443 (web, behind a reverse proxy with a certificate; the pool itself serves plain HTTP
on 8080). Keep closed: 8080, 8101 (node stratum, pool only), 10001 (wallet-api), 5432.

```sh
sudo ufw allow 22/tcp; sudo ufw allow 10000/tcp; sudo ufw allow 3333:3334/tcp; sudo ufw allow 3443:3444/tcp; sudo ufw allow 443/tcp
sudo ufw enable
```

nginx: `proxy_pass http://127.0.0.1:8080;` for `/` with a Let's Encrypt certificate.

## 9. Operations

- `admin list` shows blocks the checks could not settle and payments waiting for a decision;
  `admin block <height> confirm|orphan`, `admin payment <txid> sent|refund` resolve them (see
  [`pool/server/README.md`](../pool/server/README.md)).
- Back up `wallet.db` and `wallet.pass` (the money) and `pg_dump bumblebeam` (balances and
  history). The node database is disposable.
- Update: `git pull`, `cargo build --release`, `install`, `systemctl restart bumblebeam-pool`.
  Schema migrations run on start.
- Shares are kept seven days, hashrate samples two; the database stays small.
- Payouts lock a whole UTXO each; split coins with `tx_split` in wallet-api when many miners
  reach the threshold at once.
